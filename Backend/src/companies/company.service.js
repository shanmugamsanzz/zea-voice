import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';

function slugify(value) {
  const base = value.toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'company';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

function mapCompany(row) {
  return {
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    businessName: row.business_name,
    organizationName: row.organization_name,
    legalName: row.legal_name,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.primary_email,
    businessPhone: row.business_phone,
    website: row.website,
    billingTier: row.billing_tier,
    perMinutePrice: Number(row.per_minute_price),
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    state: row.state,
    country: row.country,
    postalCode: row.postal_code,
    timezone: row.timezone,
    status: row.status,
    workspaceName: row.workspace_name,
    locale: row.locale,
    currency: row.currency,
    teamSize: Number(row.team_size ?? 0),
    phoneNumbersCount: Number(row.phone_numbers_count ?? 0),
    creditsBalance: Number(row.credits_balance ?? 0),
    monthlySpend: Number(row.monthly_spend ?? 0),
    limits: {
      maxCampaignConcurrency: row.max_campaign_concurrency,
      maxTotalConcurrency: row.max_total_concurrency,
      maxAgents: row.max_agents,
      maxUsers: row.max_users,
      maxPhoneNumbers: row.max_phone_numbers,
      maxCampaigns: row.max_campaigns,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const companySelect = `
  SELECT count(*) OVER()::int AS full_count,
         t.id AS tenant_id, o.id AS organization_id, w.id AS workspace_id,
         t.name AS business_name, o.name AS organization_name,
         o.legal_name, o.first_name, o.last_name,
         o.primary_email, o.business_phone, o.website, o.billing_tier, o.per_minute_price,
         o.address_line1, o.address_line2, o.state, o.country, o.postal_code,
         t.timezone, t.status, w.name AS workspace_name,
         s.locale, s.currency,
         l.max_campaign_concurrency, l.max_total_concurrency, l.max_agents,
         l.max_users, l.max_phone_numbers, l.max_campaigns,
         (SELECT count(*) FROM tenant_memberships m
          WHERE m.tenant_id = t.id AND m.status = 'active' AND m.deleted_at IS NULL) AS team_size,
         (SELECT count(*) FROM phone_number_assignments p
          WHERE p.tenant_id = t.id AND p.released_at IS NULL) AS phone_numbers_count,
         (SELECT balance - reserved_balance FROM company_credit_wallets cw
          WHERE cw.tenant_id = t.id) AS credits_balance,
         (SELECT COALESCE(sum(cost), 0) FROM call_sessions c
          WHERE c.tenant_id = t.id AND c.started_at >= date_trunc('month', now())) AS monthly_spend,
         t.created_at, t.updated_at
  FROM tenants t
  JOIN organizations o ON o.tenant_id = t.id AND o.deleted_at IS NULL
  JOIN tenant_settings s ON s.tenant_id = t.id
  JOIN tenant_limits l ON l.tenant_id = t.id
  JOIN workspaces w ON w.tenant_id = t.id AND w.id = s.default_workspace_id
  WHERE t.deleted_at IS NULL`;

async function getCompanyRow(client, tenantId) {
  const result = await client.query(`${companySelect} AND t.id = $1`, [tenantId]);
  if (result.rowCount === 0) throw new AppError(404, 'Company was not found', 'COMPANY_NOT_FOUND');
  return result.rows[0];
}

function auditMetadata(metadata = {}) {
  return [metadata.requestId ?? null, metadata.ipAddress ?? null, metadata.userAgent ?? null];
}

export async function createCompany(actorUserId, input, metadata = {}) {
  try {
    return await withPlatformAdminContext(actorUserId, async (client) => {
      const tenant = (await client.query(
        `INSERT INTO tenants (name, slug, status, timezone, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.businessName, slugify(input.businessName), input.status, input.timezone, actorUserId],
      )).rows[0];

      const organization = (await client.query(
        `INSERT INTO organizations
          (tenant_id, name, legal_name, first_name, last_name, primary_email,
           business_phone, website, billing_tier, per_minute_price, address_line1, address_line2,
           state, country, postal_code, timezone, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id`,
        [tenant.id, input.organizationName ?? input.businessName, input.legalName, input.firstName, input.lastName,
          input.email, input.businessPhone, input.website, input.billingTier, input.perMinutePrice,
          input.addressLine1, input.addressLine2, input.state, input.country,
          input.postalCode, input.timezone, input.status, actorUserId],
      )).rows[0];

      const workspace = (await client.query(
        `INSERT INTO workspaces
          (tenant_id, organization_id, name, slug, status, is_default, timezone, created_by)
         VALUES ($1, $2, $3, 'default', 'active', true, $4, $5) RETURNING id`,
        [tenant.id, organization.id, input.workspaceName, input.timezone, actorUserId],
      )).rows[0];

      await client.query(
        `INSERT INTO tenant_settings (tenant_id, default_workspace_id, locale, currency)
         VALUES ($1, $2, $3, $4)`,
        [tenant.id, workspace.id, input.locale, input.currency],
      );
      await client.query(
        `INSERT INTO tenant_limits
          (tenant_id, max_campaign_concurrency, max_total_concurrency, max_agents,
           max_users, max_phone_numbers, max_campaigns)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenant.id, input.limits.maxCampaignConcurrency, input.limits.maxTotalConcurrency,
          input.limits.maxAgents, input.limits.maxUsers, input.limits.maxPhoneNumbers,
          input.limits.maxCampaigns],
      );
      await client.query(
        `INSERT INTO company_credit_wallets (tenant_id, currency) VALUES ($1, 'INR')`,
        [tenant.id],
      );

      const [requestId, ipAddress, userAgent] = auditMetadata(metadata);
      await client.query(
        `INSERT INTO audit_logs
          (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
           entity_id, after_data, request_id, ip_address, user_agent)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'COMPANY_CREATED', 'tenant', $1::uuid::text,
                 $4::jsonb, $5, $6, $7)`,
        [tenant.id, workspace.id, actorUserId, JSON.stringify({
          tenantId: tenant.id, organizationId: organization.id, workspaceId: workspace.id,
          businessName: input.businessName,
          organizationName: input.organizationName ?? input.businessName,
          workspaceName: input.workspaceName,
          status: input.status,
        }), requestId, ipAddress, userAgent],
      );

      return mapCompany(await getCompanyRow(client, tenant.id));
    });
  } catch (error) {
    if (error.code === '23505') {
      throw new AppError(409, 'A company with these identifying details already exists', 'COMPANY_CONFLICT');
    }
    throw error;
  }
}

export function getCompany(actorUserId, tenantId) {
  return withPlatformAdminContext(actorUserId, async (client) => mapCompany(await getCompanyRow(client, tenantId)));
}

export function listCompanies(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const values = [filters.search ?? null, filters.status ?? null, filters.billingTier ?? null];
    const filterSql = `
      AND ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%'
           OR o.primary_email ILIKE '%' || $1 || '%')
      AND ($2::tenant_status IS NULL OR t.status = $2)
      AND ($3::billing_tier IS NULL OR o.billing_tier = $3)`;
    const offset = (filters.page - 1) * filters.pageSize;
    const result = await client.query(
      `${companySelect} ${filterSql}
       ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`,
      [...values, filters.pageSize, offset],
    );
    const total = result.rows[0]?.full_count ?? 0;
    return {
      items: result.rows.map(mapCompany),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  });
}

export function listCompanyOptions(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(
      `SELECT t.id AS "tenantId", t.name AS "businessName"
       FROM tenants t
       WHERE t.status = 'active'
       ORDER BY t.name ASC
       LIMIT 500`,
    );
    return result.rows;
  });
}

export function updateCompany(actorUserId, tenantId, input, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = mapCompany(await getCompanyRow(client, tenantId));
    const organizationFields = {
      organizationName: 'name', legalName: 'legal_name', firstName: 'first_name', lastName: 'last_name',
      email: 'primary_email', businessPhone: 'business_phone', website: 'website',
      billingTier: 'billing_tier', perMinutePrice: 'per_minute_price',
      addressLine1: 'address_line1', addressLine2: 'address_line2',
      state: 'state', country: 'country', postalCode: 'postal_code', timezone: 'timezone',
    };
    const organizationEntries = Object.entries(organizationFields).filter(([key]) => key in input);
    if (organizationEntries.length > 0) {
      const values = organizationEntries.map(([key]) => input[key]);
      const sets = organizationEntries.map(([, column], index) => `${column} = $${index + 2}`);
      await client.query(`UPDATE organizations SET ${sets.join(', ')} WHERE tenant_id = $1`, [tenantId, ...values]);
    }
    if (input.businessName !== undefined || input.timezone !== undefined) {
      await client.query(
        `UPDATE tenants SET name = COALESCE($2, name), timezone = COALESCE($3, timezone) WHERE id = $1`,
        [tenantId, input.businessName ?? null, input.timezone ?? null],
      );
      if (input.timezone !== undefined) {
        await client.query('UPDATE workspaces SET timezone = $2 WHERE tenant_id = $1 AND is_default = true', [tenantId, input.timezone]);
      }
    }
    if (input.workspaceName !== undefined) {
      await client.query(
        'UPDATE workspaces SET name = $2 WHERE tenant_id = $1 AND is_default = true',
        [tenantId, input.workspaceName],
      );
    }
    if (input.locale !== undefined || input.currency !== undefined) {
      await client.query(
        `UPDATE tenant_settings SET locale = COALESCE($2, locale), currency = COALESCE($3, currency) WHERE tenant_id = $1`,
        [tenantId, input.locale ?? null, input.currency ?? null],
      );
    }
    if (input.limits) {
      const current = before.limits;
      const limits = { ...current, ...input.limits };
      if (limits.maxCampaignConcurrency > limits.maxTotalConcurrency) {
        throw new AppError(400, 'Campaign concurrency cannot exceed company total concurrency', 'INVALID_CONCURRENCY_LIMIT');
      }
      await client.query(
        `UPDATE tenant_limits SET
           max_campaign_concurrency = $2, max_total_concurrency = $3, max_agents = $4,
           max_users = $5, max_phone_numbers = $6, max_campaigns = $7
         WHERE tenant_id = $1`,
        [tenantId, limits.maxCampaignConcurrency, limits.maxTotalConcurrency, limits.maxAgents,
          limits.maxUsers, limits.maxPhoneNumbers, limits.maxCampaigns],
      );
    }
    const after = mapCompany(await getCompanyRow(client, tenantId));
    const [requestId, ipAddress, userAgent] = auditMetadata(metadata);
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
         entity_id, before_data, after_data, request_id, ip_address, user_agent)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'COMPANY_UPDATED', 'tenant', $1::uuid::text,
               $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [tenantId, after.workspaceId, actorUserId, JSON.stringify(before), JSON.stringify(after),
        requestId, ipAddress, userAgent],
    );
    return after;
  });
}

export function updateCompanyStatus(actorUserId, tenantId, status, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = mapCompany(await getCompanyRow(client, tenantId));
    const workspaceStatus = status === 'archived' ? 'archived' : status === 'active' ? 'active' : 'inactive';
    await client.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenantId, status]);
    await client.query('UPDATE organizations SET status = $2 WHERE tenant_id = $1', [tenantId, status]);
    await client.query('UPDATE workspaces SET status = $2 WHERE tenant_id = $1', [tenantId, workspaceStatus]);
    if (status !== 'active') {
      await client.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = $2
         WHERE tenant_id = $1 AND revoked_at IS NULL`,
        [tenantId, `company_${status}`],
      );
    }
    const after = mapCompany(await getCompanyRow(client, tenantId));
    const [requestId, ipAddress, userAgent] = auditMetadata(metadata);
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
         entity_id, before_data, after_data, request_id, ip_address, user_agent)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'COMPANY_STATUS_CHANGED', 'tenant', $1::uuid::text,
               $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [tenantId, after.workspaceId, actorUserId, JSON.stringify({ status: before.status }),
        JSON.stringify({ status: after.status }), requestId, ipAddress, userAgent],
    );
    return after;
  });
}

export function deleteCompany(actorUserId, tenantId, metadata = {}) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = mapCompany(await getCompanyRow(client, tenantId));
    const memberUsers = (await client.query(
      `SELECT user_id FROM tenant_memberships
       WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenantId],
    )).rows.map((row) => row.user_id);
    const [requestId, ipAddress, userAgent] = auditMetadata(metadata);

    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type,
         entity_id, before_data, after_data, request_id, ip_address, user_agent)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'COMPANY_DELETED', 'tenant', $1::uuid::text,
               $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [tenantId, before.workspaceId, actorUserId, JSON.stringify(before),
        JSON.stringify({ deleted: true }), requestId, ipAddress, userAgent],
    );

    await client.query(
      `UPDATE campaign_task_attempts SET status = 'canceled', ended_at = COALESCE(ended_at, now())
       WHERE tenant_id = $1 AND status IN ('scheduled', 'queued', 'ringing')`,
      [tenantId],
    );
    await client.query(
      `UPDATE campaign_tasks SET status = 'canceled', completed_at = COALESCE(completed_at, now())
       WHERE tenant_id = $1 AND status IN ('queued', 'running', 'paused')`,
      [tenantId],
    );
    await client.query(
      `UPDATE campaigns SET status = 'archived', deleted_at = COALESCE(deleted_at, now())
       WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenantId],
    );
    await client.query(
      `UPDATE voice_agents SET status = 'archived', deleted_at = COALESCE(deleted_at, now())
       WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenantId],
    );
    await client.query(
      `UPDATE phone_number_assignments
       SET released_at = now(), released_by = $2, release_reason = 'Company deleted'
       WHERE tenant_id = $1 AND released_at IS NULL`,
      [tenantId, actorUserId],
    );
    await client.query('UPDATE phone_numbers SET assigned_tenant_id = NULL WHERE assigned_tenant_id = $1', [tenantId]);
    await client.query(
      `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'company_deleted'
       WHERE tenant_id = $1 AND revoked_at IS NULL`,
      [tenantId],
    );
    await client.query(
      `UPDATE tenant_memberships SET status = 'removed', deleted_at = COALESCE(deleted_at, now())
       WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenantId],
    );
    if (memberUsers.length > 0) {
      await client.query(
        `UPDATE users u SET status = 'archived', deleted_at = COALESCE(u.deleted_at, now())
         WHERE u.id = ANY($1::uuid[]) AND u.platform_role IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM tenant_memberships m
             WHERE m.user_id = u.id AND m.deleted_at IS NULL
           )`,
        [memberUsers],
      );
    }
    await client.query(
      `UPDATE organizations SET status = 'archived', deleted_at = COALESCE(deleted_at, now())
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query(
      `UPDATE workspaces SET status = 'archived', deleted_at = COALESCE(deleted_at, now())
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query(
      `UPDATE tenants SET status = 'archived', deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`,
      [tenantId],
    );
    return { tenantId, deleted: true };
  });
}
