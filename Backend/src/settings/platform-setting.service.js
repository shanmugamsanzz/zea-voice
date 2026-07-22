import { AppError } from '../middleware/errors.js';
import { withAuthServiceContext, withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';

function normalizeIp(value) {
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function mapSettings(row) {
  return {
    adminIpAllowlist: row.admin_ip_allowlist,
    maxSessionTimeoutSeconds: row.max_session_timeout_seconds,
    compliancePolicy: row.compliance_policy,
    sipRelayRegion: row.sip_relay_region,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export function isPlatformAdminIpAllowed(ipAddress) {
  const ip = normalizeIp(ipAddress);
  return withAuthServiceContext(async (client) => {
    const result = await client.query(`SELECT EXISTS (
      SELECT 1 FROM platform_settings p,
      LATERAL unnest(p.admin_ip_allowlist) AS allowed(network)
      WHERE $1::inet <<= allowed.network
    ) AS allowed`, [ip]);
    return result.rows[0].allowed;
  });
}

export function getPlatformSettings(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query('SELECT * FROM platform_settings WHERE id = true');
    return mapSettings(result.rows[0]);
  });
}

export function updatePlatformSettings(actorUserId, input, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const current = (await client.query('SELECT * FROM platform_settings WHERE id = true FOR UPDATE')).rows[0];
    if (input.adminIpAllowlist) {
      const currentIpAllowed = await client.query(`SELECT EXISTS (
        SELECT 1 FROM unnest($1::cidr[]) AS allowed(network)
        WHERE $2::inet <<= allowed.network
      ) AS allowed`, [input.adminIpAllowlist, normalizeIp(metadata.ipAddress ?? '127.0.0.1')]);
      if (!currentIpAllowed.rows[0].allowed && !input.confirmAccessLoss) {
        throw new AppError(400, 'The new allowlist excludes your current IP; confirmAccessLoss is required',
          'ADMIN_IP_ACCESS_LOSS_CONFIRMATION_REQUIRED');
      }
    }
    const result = await client.query(`UPDATE platform_settings SET
      admin_ip_allowlist = COALESCE($1::cidr[], admin_ip_allowlist),
      max_session_timeout_seconds = COALESCE($2, max_session_timeout_seconds),
      compliance_policy = COALESCE($3::compliance_policy, compliance_policy),
      sip_relay_region = COALESCE($4::sip_relay_region, sip_relay_region),
      updated_by = $5 WHERE id = true RETURNING *`, [
      input.adminIpAllowlist ?? null, input.maxSessionTimeoutSeconds ?? null,
      input.compliancePolicy ?? null, input.sipRelayRegion ?? null, actorUserId,
    ]);
    await client.query(`INSERT INTO audit_logs
      (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data, ip_address, user_agent)
      VALUES ($1,'user','PLATFORM_SETTINGS_UPDATED','platform_settings','global',$2::jsonb,$3::jsonb,$4,$5)`, [
      actorUserId, JSON.stringify(mapSettings(current)), JSON.stringify(mapSettings(result.rows[0])),
      metadata.ipAddress ?? null, metadata.userAgent ?? null,
    ]);
    return mapSettings(result.rows[0]);
  });
}

export function getWorkspaceSettings(auth) {
  return withTenantContext(auth, async (client) => {
    const result = await client.query(`SELECT
        u.id AS user_id,u.first_name,u.last_name,u.email::text,
        t.id AS tenant_id,t.name AS tenant_name,t.timezone,
        o.id AS organization_id,o.name AS organization_name,
        w.id AS workspace_id,w.name AS workspace_name
      FROM users u
      JOIN tenants t ON t.id=$2 AND t.deleted_at IS NULL
      JOIN organizations o ON o.tenant_id=t.id AND o.deleted_at IS NULL
      JOIN workspaces w ON w.id=$3 AND w.tenant_id=t.id AND w.deleted_at IS NULL
      WHERE u.id=$1 AND u.deleted_at IS NULL LIMIT 1`, [auth.userId, auth.tenantId, auth.workspaceId]);
    if (!result.rowCount) throw new AppError(404, 'Workspace settings were not found', 'WORKSPACE_SETTINGS_NOT_FOUND');
    const row = result.rows[0];
    return {
      user: { id: row.user_id, firstName: row.first_name, lastName: row.last_name, email: row.email },
      tenant: { id: row.tenant_id, name: row.tenant_name, timezone: row.timezone },
      organization: { id: row.organization_id, name: row.organization_name },
      workspace: { id: row.workspace_id, name: row.workspace_name },
    };
  });
}
