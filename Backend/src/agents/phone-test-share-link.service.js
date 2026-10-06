import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTenantContext, withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { requireCompanyCallQueueEnabled } from '../queues/company-queue-feature.js';
import { normalizePhone } from '../campaigns/csv.js';
import { env } from '../config/env.js';
import { submitQueuedPhoneTest } from './agent-phone-test-queue.service.js';

export const phoneShareTokenHash = token => createHash('sha256').update(token).digest('hex');
const unavailable = () => new AppError(404, 'This calling link is unavailable or expired.', 'PHONE_SHARE_LINK_UNAVAILABLE');
const manage = auth => {
  if (!auth.tenantId || !auth.workspaceId || !['SUPER_ADMIN','COMPANY_DEVELOPER'].includes(auth.role) || auth.authType === 'api_key') {
    throw new AppError(403, 'An authorized user session is required to manage calling links.', 'FORBIDDEN');
  }
};
export function shareLinkSummary(row, token) {
  return { id: row.id, agentId: row.agent_id, expiresAt: row.expires_at, permanent: row.expires_at == null,
    revokedAt: row.revoked_at, createdAt: row.created_at, ...(token ? { token } : {}) };
}
async function validAgent(client, auth, agentId) {
  const result = await client.query(`SELECT a.name FROM voice_agents a JOIN tenants t ON t.id=a.tenant_id
    JOIN workspaces w ON w.id=a.workspace_id AND w.tenant_id=a.tenant_id
    WHERE a.id=$1 AND a.tenant_id=$2 AND a.workspace_id=$3 AND a.status='active' AND a.deleted_at IS NULL
      AND a.usage_direction IN ('outbound','both') AND t.status='active' AND t.deleted_at IS NULL
      AND w.status='active' AND w.deleted_at IS NULL`, [agentId, auth.tenantId, auth.workspaceId]);
  if (!result.rowCount) throw unavailable();
  return result.rows[0];
}
export async function createPhoneTestShareLink(auth, agentId, input, deps = {}) {
  manage(auth); requireCompanyCallQueueEnabled(auth.tenantId);
  if (!['24h','permanent'].includes(input.expiresIn)) throw new AppError(400, 'Choose 24 hours or permanent.', 'VALIDATION_ERROR');
  const run = deps.tenantContextRunner ?? (operation => withTenantContext(auth, operation));
  return run(async client => {
    await validAgent(client, auth, agentId);
    const token = randomBytes(32).toString('base64url');
    const expires = input.expiresIn === 'permanent' ? null : new Date((deps.now?.() ?? Date.now()) + 86400000);
    const result = await client.query(`INSERT INTO phone_test_share_links
      (id,tenant_id,workspace_id,agent_id,created_by,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), auth.tenantId, auth.workspaceId, agentId, auth.userId, phoneShareTokenHash(token), expires]);
    await audit(client, auth, 'PHONE_SHARE_LINK_CREATED', result.rows[0].id);
    return shareLinkSummary(result.rows[0], token);
  });
}
export async function listPhoneTestShareLinks(auth, agentId, deps = {}) {
  manage(auth);
  const run = deps.tenantContextRunner ?? (operation => withTenantContext(auth, operation));
  return run(async client => (await client.query(`SELECT id,agent_id,expires_at,revoked_at,created_at FROM phone_test_share_links
    WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 ORDER BY created_at DESC LIMIT 100`,
  [auth.tenantId, auth.workspaceId, agentId])).rows.map(row => shareLinkSummary(row)));
}
export async function revokePhoneTestShareLink(auth, agentId, linkId, deps = {}) {
  manage(auth);
  const run = deps.tenantContextRunner ?? (operation => withTenantContext(auth, operation));
  return run(async client => {
    // Match submission/worker lock order so revocation cannot race queued dialing.
    await client.query('SELECT tenant_id FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE', [auth.tenantId]);
    const result = await client.query(`UPDATE phone_test_share_links SET revoked_at=COALESCE(revoked_at,now())
      WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND agent_id=$4 RETURNING *`,
    [linkId, auth.tenantId, auth.workspaceId, agentId]);
    if (!result.rowCount) throw unavailable();
    await client.query(`UPDATE agent_phone_test_requests SET status='canceled',updated_at=now()
      WHERE share_link_id=$1 AND tenant_id=$2 AND status='queued'`, [linkId, auth.tenantId]);
    await audit(client, auth, 'PHONE_SHARE_LINK_REVOKED', linkId);
    return shareLinkSummary(result.rows[0]);
  });
}
async function audit(client, auth, action, id) {
  await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id)
    VALUES($1,$2,$3,'user',$4,'phone_test_share_link',$5)`, [auth.tenantId, auth.workspaceId, auth.userId, action, id]);
}

// Used inside the queue transaction as well as before public requests. Locking
// the link serializes expiry/revocation checks with request acceptance.
export async function validatePhoneTestShareLink(client, linkId, scope) {
  const result = await client.query(`SELECT l.* FROM phone_test_share_links l
    JOIN users u ON u.id=l.created_by AND u.status='active' AND u.deleted_at IS NULL
    WHERE l.id=$1 AND l.tenant_id=$2 AND l.workspace_id=$3 AND l.agent_id=$4
      AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>now())
      AND (u.platform_role='super_admin' OR EXISTS (SELECT 1 FROM tenant_memberships m
        WHERE m.user_id=u.id AND m.tenant_id=l.tenant_id AND m.workspace_id=l.workspace_id
          AND m.status='active' AND m.deleted_at IS NULL AND m.role='company_developer')) FOR SHARE OF l`,
  [linkId, scope.tenantId, scope.workspaceId, scope.agentId]);
  if (!result.rowCount) throw unavailable();
  await validAgent(client, scope, scope.agentId);
  return result.rows[0];
}
async function resolve(token, deps = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw unavailable();
  const run = deps.contextRunner ?? withPlatformAdminContext;
  return run(null, async client => {
    const lookup = await client.query('SELECT id,tenant_id,workspace_id,agent_id FROM phone_test_share_links WHERE token_hash=$1', [phoneShareTokenHash(token)]);
    if (!lookup.rowCount) throw unavailable();
    const row = lookup.rows[0];
    const link = await validatePhoneTestShareLink(client, row.id, { tenantId: row.tenant_id, workspaceId: row.workspace_id, agentId: row.agent_id });
    requireCompanyCallQueueEnabled(link.tenant_id);
    return link;
  });
}
export async function getPublicPhoneTestLink(token, deps = {}) {
  const link = await resolve(token, deps);
  const run = deps.contextRunner ?? withPlatformAdminContext;
  const agent = await run(null, client => validAgent(client, { tenantId: link.tenant_id, workspaceId: link.workspace_id }, link.agent_id));
  return { agentName: agent.name, expiresAt: link.expires_at, permanent: link.expires_at == null };
}
export async function requestPublicPhoneTest(token, input, ip, deps = {}) {
  if (input.consent !== true || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId ?? '')) {
    throw new AppError(400, 'Confirm that you want to receive this call.', 'VALIDATION_ERROR');
  }
  const link = await resolve(token, deps);
  const phone = normalizePhone(input.phone);
  if (!phone || !env.PHONE_TEST_SHARE_ALLOWED_DIAL_CODES.split(',').some(code => phone.startsWith(`+${code.trim()}`))) {
    throw new AppError(400, 'This phone number or country is not available for shared calls.', 'PHONE_SHARE_DESTINATION_UNAVAILABLE');
  }
  const { consumePhoneShareCallLimits } = await import('./phone-test-share-rate-limit.js');
  await (deps.consumeLimits ?? consumePhoneShareCallLimits)({ linkId: link.id, tenantId: link.tenant_id, phone, ip });
  let result;
  try {
    result = await submitQueuedPhoneTest({ tenantId: link.tenant_id, workspaceId: link.workspace_id, userId: link.created_by },
      link.agent_id, { phone, requestId: input.requestId, shareLinkId: link.id }, deps);
  } catch (error) {
    if (error.code === 'PHONE_SHARE_LINK_UNAVAILABLE') throw error;
    if (error.code === 'COMPANY_OUTBOUND_QUEUE_FULL') throw new AppError(429, 'The waiting queue is full. Please try again later.', 'PHONE_SHARE_QUEUE_FULL');
    if (error.code === 'PHONE_TEST_REQUEST_CONFLICT') throw new AppError(409, 'This call request has already been used.', 'PHONE_SHARE_REQUEST_CONFLICT');
    if (error instanceof AppError) throw new AppError(503, 'Calling is temporarily unavailable. Please try again later.', 'PHONE_SHARE_CALL_UNAVAILABLE');
    throw error;
  }
  return { id: result.id, status: result.status, reason: result.reason };
}
export async function getPublicPhoneTestStatus(token, id, key, deps = {}) {
  const link = await resolve(token, deps);
  const run = deps.contextRunner ?? withPlatformAdminContext;
  return run(null, async client => {
    const result = await client.query(`SELECT id,status,queue_reason FROM agent_phone_test_requests
      WHERE id=$1 AND request_key=$2 AND share_link_id=$3 AND tenant_id=$4`, [id, key, link.id, link.tenant_id]);
    if (!result.rowCount) throw unavailable();
    return { id: result.rows[0].id, status: result.rows[0].status, reason: result.rows[0].queue_reason };
  });
}
