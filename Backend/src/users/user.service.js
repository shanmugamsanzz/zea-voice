import crypto from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

function splitName(value) {
  const parts = value.trim().split(/\s+/);
  return { firstName: parts.shift(), lastName: parts.join(' ') || '-' };
}
function mapUser(row) {
  return { id: row.id, userId: row.user_id, fullName: [row.first_name, row.last_name === '-' ? '' : row.last_name].filter(Boolean).join(' '),
    email: row.email, role: 'COMPANY_USER', status: row.status, lastActiveAt: row.last_login_at,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
const select = `SELECT m.id, m.user_id, m.status, m.created_at, m.updated_at,
  u.first_name, u.last_name, u.email::text, u.last_login_at
  FROM tenant_memberships m JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL
  WHERE m.tenant_id=$1 AND m.role='company_user' AND m.deleted_at IS NULL`;

async function row(client, tenantId, id) {
  const result = await client.query(`${select} AND m.id=$2`, [tenantId, id]);
  if (!result.rowCount) throw new AppError(404, 'Company user was not found', 'COMPANY_USER_NOT_FOUND');
  return result.rows[0];
}
export function listCompanyUsers(auth, filters) {
  return withTenantContext(auth, async (client) => {
    const values = [auth.tenantId, filters.search ?? null, filters.status ?? null];
    const where = ` AND ($2::text IS NULL OR u.first_name ILIKE '%'||$2||'%' OR u.last_name ILIKE '%'||$2||'%' OR u.email::text ILIKE '%'||$2||'%')
      AND ($3::membership_status IS NULL OR m.status=$3)`;
    const total = await client.query(`SELECT count(*)::int total FROM tenant_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.role='company_user' AND m.deleted_at IS NULL ${where}`, values);
    const result = await client.query(`${select} ${where} ORDER BY m.created_at DESC LIMIT $4 OFFSET $5`,
      [...values, filters.pageSize, (filters.page - 1) * filters.pageSize]);
    return { items: result.rows.map(mapUser), pagination: { page: filters.page, pageSize: filters.pageSize,
      total: total.rows[0].total, totalPages: Math.ceil(total.rows[0].total / filters.pageSize) } };
  });
}
export async function createCompanyUser(auth, input, metadata = {}) {
  const names = splitName(input.fullName);
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTenantContext(auth, async (client) => {
      const limit = await client.query('SELECT max_users FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE', [auth.tenantId]);
      const memberCount = await client.query(`SELECT count(*)::int AS count FROM tenant_memberships
        WHERE tenant_id=$1 AND status<>'removed' AND deleted_at IS NULL`, [auth.tenantId]);
      if (!limit.rowCount || memberCount.rows[0].count >= limit.rows[0].max_users) {
        throw new AppError(409, 'The company user limit has been reached', 'COMPANY_USER_LIMIT_REACHED');
      }
      const user = { id: crypto.randomUUID() };
      await client.query(`INSERT INTO users (id,email,password_hash,first_name,last_name,status,email_verified_at,created_by)
        VALUES ($1,$2,$3,$4,$5,'active',now(),$6)`,
      [user.id, input.email, passwordHash, names.firstName, names.lastName, auth.userId]);
      const membership = (await client.query(`INSERT INTO tenant_memberships
        (tenant_id,workspace_id,user_id,role,status,invited_by,joined_at)
        VALUES ($1,$2,$3,'company_user','active',$4,now()) RETURNING id`,
      [auth.tenantId, auth.workspaceId, user.id, auth.userId])).rows[0];
      await client.query(`INSERT INTO audit_logs (tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,after_data,request_id,ip_address,user_agent)
        VALUES ($1,$2,$3,'user','COMPANY_USER_CREATED','tenant_membership',$4,$5::jsonb,$6,$7,$8)`,
      [auth.tenantId, auth.workspaceId, auth.userId, membership.id, JSON.stringify({ email: input.email }),
        metadata.requestId ?? null, metadata.ipAddress ?? null, metadata.userAgent ?? null]);
      return mapUser(await row(client, auth.tenantId, membership.id));
    });
  } catch (error) {
    if (error.code === '23505') throw new AppError(409, 'A user with this email already exists', 'COMPANY_USER_EMAIL_EXISTS');
    throw error;
  }
}
export function updateCompanyUserStatus(auth, id, status) {
  return withTenantContext(auth, async (client) => {
    await row(client, auth.tenantId, id);
    await client.query(`UPDATE tenant_memberships SET status=$3::membership_status,
      joined_at=CASE WHEN $3='active' AND joined_at IS NULL THEN now() ELSE joined_at END
      WHERE tenant_id=$1 AND id=$2 AND role='company_user'`, [auth.tenantId, id, status]);
    if (status !== 'active') await client.query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='company_user_suspended'
      WHERE membership_id=$1 AND revoked_at IS NULL`, [id]);
    await client.query(`INSERT INTO audit_logs (tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,after_data)
      VALUES ($1,$2,$3,'user','COMPANY_USER_STATUS_CHANGED','tenant_membership',$4,$5::jsonb)`,
    [auth.tenantId, auth.workspaceId, auth.userId, id, JSON.stringify({ status })]);
    return mapUser(await row(client, auth.tenantId, id));
  });
}
