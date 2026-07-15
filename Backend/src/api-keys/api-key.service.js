import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { withAuthServiceContext, withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { hashToken } from '../auth/tokens.js';

const KEY_PREFIX = 'zea_live_';

function generateApiKey() {
  return `${KEY_PREFIX}${crypto.randomBytes(36).toString('base64url')}`;
}

function mapApiKey(row) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopeType: row.tenant_id ? 'company' : 'platform',
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function ensureFutureExpiry(expiresAt) {
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw new AppError(400, 'API key expiry must be in the future', 'INVALID_API_KEY_EXPIRY');
  }
}

async function insertKey(client, auth, input) {
  ensureFutureExpiry(input.expiresAt);
  const rawKey = generateApiKey();
  const result = await client.query(`INSERT INTO api_keys
    (tenant_id, workspace_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8) RETURNING *`, [
    auth.role === 'SUPER_ADMIN' ? null : auth.tenantId,
    auth.role === 'SUPER_ADMIN' ? null : auth.workspaceId,
    input.name,
    rawKey.slice(0, 20),
    hashToken(rawKey),
    input.scopes,
    auth.userId,
    input.expiresAt ?? null,
  ]);
  const key = result.rows[0];
  await client.query(`INSERT INTO audit_logs
    (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
    VALUES ($1, $2, $3, 'user', 'API_KEY_CREATED', 'api_key', $4, $5::jsonb)`, [
    key.tenant_id, key.workspace_id, auth.userId, key.id,
    JSON.stringify({ name: key.name, keyPrefix: key.key_prefix, scopes: key.scopes }),
  ]);
  return { ...mapApiKey(key), key: rawKey };
}

function inOwnerContext(auth, operation) {
  return auth.role === 'SUPER_ADMIN'
    ? withPlatformAdminContext(auth.userId, operation)
    : withTenantContext(auth, operation);
}

export function createApiKey(auth, input) {
  return inOwnerContext(auth, (client) => insertKey(client, auth, input));
}

export function listApiKeys(auth) {
  return inOwnerContext(auth, async (client) => {
    const result = await client.query(`SELECT * FROM api_keys
      WHERE ($1::boolean OR tenant_id = $2)
      ORDER BY created_at DESC`, [auth.role === 'SUPER_ADMIN', auth.tenantId ?? null]);
    return result.rows.map(mapApiKey);
  });
}

async function ownedKey(client, auth, apiKeyId, lock = false) {
  const result = await client.query(`SELECT * FROM api_keys WHERE id = $1
    AND ($2::boolean OR tenant_id = $3) ${lock ? 'FOR UPDATE' : ''}`,
  [apiKeyId, auth.role === 'SUPER_ADMIN', auth.tenantId ?? null]);
  if (!result.rowCount) throw new AppError(404, 'API key was not found', 'API_KEY_NOT_FOUND');
  return result.rows[0];
}

export function revokeApiKey(auth, apiKeyId, reason) {
  return inOwnerContext(auth, async (client) => {
    const key = await ownedKey(client, auth, apiKeyId, true);
    if (!key.revoked_at) {
      await client.query(`UPDATE api_keys SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
        WHERE id = $1`, [apiKeyId, auth.userId, reason]);
      await client.query(`INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
        VALUES ($1, $2, $3, 'user', 'API_KEY_REVOKED', 'api_key', $4, $5::jsonb)`,
      [key.tenant_id, key.workspace_id, auth.userId, key.id, JSON.stringify({ reason })]);
    }
    return mapApiKey((await client.query('SELECT * FROM api_keys WHERE id = $1', [apiKeyId])).rows[0]);
  });
}

export function rotateApiKey(auth, apiKeyId, input) {
  return inOwnerContext(auth, async (client) => {
    const oldKey = await ownedKey(client, auth, apiKeyId, true);
    if (oldKey.revoked_at) throw new AppError(409, 'Revoked API keys cannot be rotated', 'API_KEY_REVOKED');
    const replacement = await insertKey(client, auth, {
      name: `${oldKey.name} (rotated)`, scopes: oldKey.scopes,
      expiresAt: input.expiresAt ?? oldKey.expires_at?.toISOString(),
    });
    await client.query(`UPDATE api_keys SET revoked_at = now(), revoked_by = $2,
      revoke_reason = 'Rotated to replacement key' WHERE id = $1`, [apiKeyId, auth.userId]);
    return replacement;
  });
}

export async function authenticateApiKey(rawKey, metadata = {}) {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const keyHash = hashToken(rawKey);
  const auth = await withAuthServiceContext(async (client) => {
    const result = await client.query(`SELECT k.*, t.status AS tenant_status, t.deleted_at AS tenant_deleted_at,
        w.status AS workspace_status, w.deleted_at AS workspace_deleted_at,
        u.email::text, u.first_name, u.last_name
      FROM api_keys k
      LEFT JOIN tenants t ON t.id = k.tenant_id
      LEFT JOIN workspaces w ON w.id = k.workspace_id AND w.tenant_id = k.tenant_id
      LEFT JOIN users u ON u.id = k.created_by
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
      LIMIT 1 FOR UPDATE OF k`, [keyHash]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (row.tenant_id && (row.tenant_status !== 'active' || row.tenant_deleted_at
      || row.workspace_status !== 'active' || row.workspace_deleted_at)) return null;
    await client.query('UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1',
      [row.id, metadata.ipAddress ?? null]);
    return {
      authType: 'api_key', apiKeyId: row.id, sessionId: null, userId: row.created_by,
      email: row.email ?? null, firstName: row.first_name ?? 'API', lastName: row.last_name ?? 'Key',
      role: row.tenant_id ? 'COMPANY_DEVELOPER' : 'SUPER_ADMIN',
      tenantId: row.tenant_id, workspaceId: row.workspace_id, scopes: row.scopes,
    };
  });
  if (!auth) throw new AppError(401, 'API key is invalid, expired or revoked', 'INVALID_API_KEY');
  return auth;
}

export function isApiKeyToken(token) {
  return token.startsWith(KEY_PREFIX);
}
