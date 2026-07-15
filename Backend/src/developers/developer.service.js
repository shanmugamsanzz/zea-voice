import { hashPassword } from '../auth/password.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts.shift(),
    lastName: parts.join(' ') || '-',
  };
}

function mapDeveloper(row) {
  const lastName = row.last_name === '-' ? '' : row.last_name;
  return {
    id: row.id,
    userId: row.user_id,
    fullName: [row.first_name, lastName].filter(Boolean).join(' '),
    firstName: row.first_name,
    lastName,
    email: row.email,
    companyId: row.tenant_id,
    companyName: row.company_name,
    workspaceId: row.workspace_id,
    role: row.membership_role === 'company_developer' ? 'COMPANY_DEVELOPER' : 'COMPANY_USER',
    status: row.membership_status,
    lastActiveAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const developerSelect = `
  SELECT count(*) OVER()::int AS full_count,
         m.id, u.id AS user_id, u.first_name, u.last_name, u.email::text, u.last_login_at,
         m.tenant_id, m.workspace_id, m.role AS membership_role, m.status AS membership_status,
         t.name AS company_name, m.created_at, m.updated_at
  FROM tenant_memberships m
  JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
  JOIN tenants t ON t.id = m.tenant_id AND t.deleted_at IS NULL
  WHERE m.role IN ('company_developer', 'company_user') AND m.deleted_at IS NULL`;

async function getDeveloperRow(client, developerId) {
  const result = await client.query(`${developerSelect} AND m.id = $1`, [developerId]);
  if (result.rowCount === 0) throw new AppError(404, 'Developer was not found', 'DEVELOPER_NOT_FOUND');
  return result.rows[0];
}

function auditValues(metadata) {
  return [metadata.requestId ?? null, metadata.ipAddress ?? null, metadata.userAgent ?? null];
}

export async function createDeveloper(actorUserId, input, metadata = {}) {
  const passwordHash = await hashPassword(input.password);
  const { firstName, lastName } = splitName(input.fullName);

  try {
    return await withPlatformAdminContext(actorUserId, async (client) => {
      const companyResult = await client.query(
        `SELECT t.id, t.status, s.default_workspace_id, w.status AS workspace_status,
                l.max_users
         FROM tenants t
         JOIN tenant_settings s ON s.tenant_id = t.id
         JOIN workspaces w ON w.tenant_id = t.id AND w.id = s.default_workspace_id
         JOIN tenant_limits l ON l.tenant_id = t.id
         WHERE t.id = $1 AND t.deleted_at IS NULL
         FOR UPDATE OF t, l`,
        [input.companyId],
      );
      if (companyResult.rowCount === 0) {
        throw new AppError(404, 'Company was not found', 'COMPANY_NOT_FOUND');
      }
      const company = companyResult.rows[0];
      if (company.status !== 'active' || company.workspace_status !== 'active') {
        throw new AppError(409, 'Users can only be assigned to an active company', 'COMPANY_NOT_ACTIVE');
      }

      const memberCount = await client.query(
        `SELECT count(*)::int AS count FROM tenant_memberships
         WHERE tenant_id = $1 AND status <> 'removed' AND deleted_at IS NULL`,
        [input.companyId],
      );
      if (memberCount.rows[0].count >= company.max_users) {
        throw new AppError(409, 'The company user limit has been reached', 'COMPANY_USER_LIMIT_REACHED', {
          maxUsers: company.max_users,
        });
      }

      const user = (await client.query(
        `INSERT INTO users
          (email, password_hash, first_name, last_name, status, email_verified_at, created_by)
         VALUES ($1, $2, $3, $4, 'active', now(), $5) RETURNING id`,
        [input.email, passwordHash, firstName, lastName, actorUserId],
      )).rows[0];
      const membership = (await client.query(
        `INSERT INTO tenant_memberships
          (tenant_id, workspace_id, user_id, role, status, invited_by, joined_at)
         VALUES ($1, $2, $3, $4::membership_role, 'active', $5, now()) RETURNING id`,
        [input.companyId, company.default_workspace_id, user.id, input.role, actorUserId],
      )).rows[0];

      const [requestId, ipAddress, userAgent] = auditValues(metadata);
      await client.query(
        `INSERT INTO audit_logs
          (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
           entity_id, after_data, request_id, ip_address, user_agent)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'TENANT_USER_CREATED',
                 'tenant_membership', $4::uuid::text, $5::jsonb, $6, $7, $8)`,
        [input.companyId, company.default_workspace_id, actorUserId, membership.id,
          JSON.stringify({ membershipId: membership.id, userId: user.id, email: input.email, role: input.role }),
          requestId, ipAddress, userAgent],
      );
      return mapDeveloper(await getDeveloperRow(client, membership.id));
    });
  } catch (error) {
    if (error.code === '23505') {
      throw new AppError(409, 'A user with this email already exists', 'USER_EMAIL_EXISTS');
    }
    throw error;
  }
}

export function getDeveloper(actorUserId, developerId) {
  return withPlatformAdminContext(actorUserId, async (client) => (
    mapDeveloper(await getDeveloperRow(client, developerId))
  ));
}

export function listDevelopers(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const values = [filters.search ?? null, filters.companyId ?? null, filters.status ?? null, filters.role ?? null];
    const filterSql = `
      AND ($1::text IS NULL OR u.first_name ILIKE '%' || $1 || '%'
           OR u.last_name ILIKE '%' || $1 || '%' OR u.email::text ILIKE '%' || $1 || '%'
           OR t.name ILIKE '%' || $1 || '%')
      AND ($2::uuid IS NULL OR m.tenant_id = $2)
      AND ($3::membership_status IS NULL OR m.status = $3)
      AND ($4::membership_role IS NULL OR m.role = $4)`;
    const offset = (filters.page - 1) * filters.pageSize;
    const result = await client.query(
      `${developerSelect} ${filterSql}
       ORDER BY m.created_at DESC LIMIT $5 OFFSET $6`,
      [...values, filters.pageSize, offset],
    );
    const total = result.rows[0]?.full_count ?? 0;
    return {
      items: result.rows.map(mapDeveloper),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  });
}

export function updateDeveloperStatus(actorUserId, developerId, status, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = await getDeveloperRow(client, developerId);
    const result = await client.query(
      `UPDATE tenant_memberships SET status = $2::membership_status,
         joined_at = CASE WHEN $2::membership_status = 'active' AND joined_at IS NULL THEN now() ELSE joined_at END
       WHERE id = $1 AND role IN ('company_developer', 'company_user') AND deleted_at IS NULL
       RETURNING id`,
      [developerId, status],
    );
    if (result.rowCount === 0) throw new AppError(404, 'Developer was not found', 'DEVELOPER_NOT_FOUND');
    if (status !== 'active') {
      await client.query(
        `UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'tenant_user_suspended'
         WHERE membership_id = $1 AND revoked_at IS NULL`,
        [developerId],
      );
    }
    const after = await getDeveloperRow(client, developerId);
    const [requestId, ipAddress, userAgent] = auditValues(metadata);
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
         entity_id, before_data, after_data, request_id, ip_address, user_agent)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'TENANT_USER_STATUS_CHANGED',
               'tenant_membership', $4::uuid::text, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [after.tenant_id, after.workspace_id, actorUserId, developerId,
        JSON.stringify({ status: before.membership_status }),
        JSON.stringify({ status: after.membership_status }), requestId, ipAddress, userAgent],
    );
    return mapDeveloper(after);
  });
}

export function updateDeveloper(actorUserId, developerId, input, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const beforeRow = await getDeveloperRow(client, developerId);
    const before = mapDeveloper(beforeRow);
    const targetCompanyId = input.companyId ?? beforeRow.tenant_id;
    let targetWorkspaceId = beforeRow.workspace_id;

    if (targetCompanyId !== beforeRow.tenant_id) {
      const target = await client.query(
        `SELECT t.status, s.default_workspace_id, w.status AS workspace_status, l.max_users
         FROM tenants t
         JOIN tenant_settings s ON s.tenant_id = t.id
         JOIN workspaces w ON w.id = s.default_workspace_id AND w.tenant_id = t.id
         JOIN tenant_limits l ON l.tenant_id = t.id
         WHERE t.id = $1 AND t.deleted_at IS NULL FOR UPDATE OF t, l`,
        [targetCompanyId],
      );
      if (!target.rowCount) throw new AppError(404, 'Company was not found', 'COMPANY_NOT_FOUND');
      if (target.rows[0].status !== 'active' || target.rows[0].workspace_status !== 'active') {
        throw new AppError(409, 'Users can only be assigned to an active company', 'COMPANY_NOT_ACTIVE');
      }
      const count = await client.query(
        `SELECT count(*)::int AS count FROM tenant_memberships
         WHERE tenant_id = $1 AND status <> 'removed' AND deleted_at IS NULL`,
        [targetCompanyId],
      );
      if (count.rows[0].count >= target.rows[0].max_users) {
        throw new AppError(409, 'The company user limit has been reached', 'COMPANY_USER_LIMIT_REACHED');
      }
      targetWorkspaceId = target.rows[0].default_workspace_id;
    }

    try {
      if (input.fullName !== undefined || input.email !== undefined) {
        const names = input.fullName === undefined ? null : splitName(input.fullName);
        await client.query(
          `UPDATE users SET
             first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
             email = COALESCE($4, email)
           WHERE id = $1 AND deleted_at IS NULL`,
          [beforeRow.user_id, names?.firstName ?? null, names?.lastName ?? null, input.email ?? null],
        );
      }
      await client.query(
        `UPDATE tenant_memberships SET tenant_id = $2, workspace_id = $3,
           role = COALESCE($4::membership_role, role)
         WHERE id = $1 AND deleted_at IS NULL`,
        [developerId, targetCompanyId, targetWorkspaceId, input.role ?? null],
      );
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'A user with this email already exists', 'USER_EMAIL_EXISTS');
      throw error;
    }

    const roleChanged = input.role !== undefined && input.role !== beforeRow.membership_role;
    const companyChanged = targetCompanyId !== beforeRow.tenant_id;
    if (roleChanged || companyChanged) {
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'tenant_user_updated'
         WHERE membership_id = $1 AND revoked_at IS NULL`,
        [developerId],
      );
    }
    if (companyChanged || input.role === 'company_user') {
      await client.query(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()), revoked_by = $2,
           revoke_reason = 'tenant_user_updated'
         WHERE created_by = $1 AND revoked_at IS NULL`,
        [beforeRow.user_id, actorUserId],
      );
    }

    const after = mapDeveloper(await getDeveloperRow(client, developerId));
    const [requestId, ipAddress, userAgent] = auditValues(metadata);
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
         entity_id, before_data, after_data, request_id, ip_address, user_agent)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'TENANT_USER_UPDATED',
               'tenant_membership', $4::uuid::text, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [after.companyId, after.workspaceId, actorUserId, developerId,
        JSON.stringify(before), JSON.stringify(after), requestId, ipAddress, userAgent],
    );
    return after;
  });
}

export function deleteDeveloper(actorUserId, developerId, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = await getDeveloperRow(client, developerId);
    const [requestId, ipAddress, userAgent] = auditValues(metadata);
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
         entity_id, before_data, after_data, request_id, ip_address, user_agent)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'TENANT_USER_DELETED',
               'tenant_membership', $4::uuid::text, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [before.tenant_id, before.workspace_id, actorUserId, developerId,
        JSON.stringify(mapDeveloper(before)), JSON.stringify({ deleted: true }),
        requestId, ipAddress, userAgent],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'tenant_user_deleted'
       WHERE membership_id = $1 AND revoked_at IS NULL`,
      [developerId],
    );
    await client.query(
      `UPDATE tenant_memberships SET status = 'removed', deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [developerId],
    );
    await client.query(
      `UPDATE users u SET status = 'archived', deleted_at = COALESCE(deleted_at, now())
       WHERE u.id = $1 AND u.platform_role IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM tenant_memberships m
           WHERE m.user_id = u.id AND m.deleted_at IS NULL
         )`,
      [before.user_id],
    );
    return { id: developerId, userId: before.user_id, deleted: true };
  });
}
