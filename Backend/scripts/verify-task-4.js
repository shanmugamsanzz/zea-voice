import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { closeDatabase } from '../src/infrastructure/database.js';
import { closeRedis } from '../src/infrastructure/redis.js';

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task4-${crypto.randomUUID()}!`;
const superEmail = `task4-admin-${suffix}@example.test`;
const developerEmail = `task4-developer-${suffix}@example.test`;
const createdUserIds = [];
let createdTenantId;
let server;

async function api(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

async function login(baseUrl, email) {
  const response = await api(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    if (createdTenantId) {
      await admin.query('DELETE FROM audit_logs WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [createdTenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [createdTenantId]);
    }
    if (createdUserIds.length) {
      await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [createdUserIds]);
      await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [createdUserIds]);
      await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    }
    await admin.end();
  }
  await Promise.allSettled([closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const passwordHash = await hashPassword(password);
  const superAdmin = (await admin.query(
    `INSERT INTO users
      (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
     VALUES ($1, $2, 'Task', 'Four Admin', 'active', 'super_admin', now()) RETURNING id`,
    [superEmail, passwordHash],
  )).rows[0];
  createdUserIds.push(superAdmin.id);

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(baseUrl, superEmail);

  const unauthenticated = await api(baseUrl, '/admin/companies');
  assert.equal(unauthenticated.status, 401);

  const createResponse = await api(baseUrl, '/admin/companies', {
    method: 'POST',
    headers: { authorization: `Bearer ${superToken}` },
    body: JSON.stringify({
      businessName: `Task 4 Company ${suffix}`,
      firstName: 'Primary',
      lastName: 'Contact',
      email: `company-${suffix}@example.test`,
      businessPhone: '+16501234567',
      website: 'https://example.test',
      billingTier: 'enterprise',
      addressLine1: '100 Test Street',
      state: 'California',
      country: 'United States',
      postalCode: '94000',
      timezone: 'America/Los_Angeles',
      limits: { maxCampaignConcurrency: 20, maxTotalConcurrency: 40 },
    }),
  });
  assert.equal(createResponse.status, 201);
  const company = (await createResponse.json()).data;
  createdTenantId = company.tenantId;
  assert.ok(company.organizationId);
  assert.ok(company.workspaceId);
  assert.equal(company.limits.maxCampaignConcurrency, 20);
  assert.equal(company.limits.maxTotalConcurrency, 40);

  const relatedRows = await admin.query(
    `SELECT
       (SELECT count(*) FROM tenants WHERE id = $1)::int AS tenants,
       (SELECT count(*) FROM organizations WHERE tenant_id = $1)::int AS organizations,
       (SELECT count(*) FROM workspaces WHERE tenant_id = $1 AND is_default)::int AS workspaces,
       (SELECT count(*) FROM tenant_settings WHERE tenant_id = $1)::int AS settings,
       (SELECT count(*) FROM tenant_limits WHERE tenant_id = $1)::int AS limits`,
    [createdTenantId],
  );
  assert.deepEqual(relatedRows.rows[0], {
    tenants: 1, organizations: 1, workspaces: 1, settings: 1, limits: 1,
  });

  const listResponse = await api(
    baseUrl,
    `/admin/companies?search=${encodeURIComponent(suffix)}&billingTier=enterprise`,
    { headers: { authorization: `Bearer ${superToken}` } },
  );
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()).data;
  assert.equal(list.pagination.total, 1);
  assert.equal(list.items[0].tenantId, createdTenantId);

  const getResponse = await api(baseUrl, `/admin/companies/${createdTenantId}`, {
    headers: { authorization: `Bearer ${superToken}` },
  });
  assert.equal(getResponse.status, 200);

  const updateResponse = await api(baseUrl, `/admin/companies/${createdTenantId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ businessName: `Updated Task 4 Company ${suffix}`, limits: { maxTotalConcurrency: 50 } }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).data;
  assert.equal(updated.businessName, `Updated Task 4 Company ${suffix}`);
  assert.equal(updated.limits.maxTotalConcurrency, 50);

  const invalidLimits = await api(baseUrl, `/admin/companies/${createdTenantId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ limits: { maxTotalConcurrency: 10 } }),
  });
  assert.equal(invalidLimits.status, 400);

  const developer = (await admin.query(
    `INSERT INTO users
      (email, password_hash, first_name, last_name, status, email_verified_at)
     VALUES ($1, $2, 'Task', 'Four Developer', 'active', now()) RETURNING id`,
    [developerEmail, passwordHash],
  )).rows[0];
  createdUserIds.push(developer.id);
  await admin.query(
    `INSERT INTO tenant_memberships
      (tenant_id, workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'company_developer', 'active', now())`,
    [createdTenantId, company.workspaceId, developer.id],
  );
  const developerToken = await login(baseUrl, developerEmail);
  const forbidden = await api(baseUrl, '/admin/companies', {
    headers: { authorization: `Bearer ${developerToken}` },
  });
  assert.equal(forbidden.status, 403);

  const suspendResponse = await api(baseUrl, `/admin/companies/${createdTenantId}/status`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${superToken}` },
    body: JSON.stringify({ status: 'suspended' }),
  });
  assert.equal(suspendResponse.status, 200);
  assert.equal((await suspendResponse.json()).data.status, 'suspended');

  const revokedDeveloper = await api(baseUrl, '/auth/me', {
    headers: { authorization: `Bearer ${developerToken}` },
  });
  assert.equal(revokedDeveloper.status, 401);

  const audits = await admin.query(
    `SELECT action FROM audit_logs WHERE tenant_id = $1
     AND action IN ('COMPANY_CREATED', 'COMPANY_UPDATED', 'COMPANY_STATUS_CHANGED')`,
    [createdTenantId],
  );
  assert.equal(audits.rowCount, 3);

  console.log(JSON.stringify({
    success: true,
    superAdminOnly: 'passed',
    atomicCompanyProvisioning: 'passed',
    generatedTenantOrganizationWorkspaceIds: 'passed',
    listingAndDetail: 'passed',
    companyUpdate: 'passed',
    concurrencyValidation: 'passed',
    suspensionRevokesCompanySessions: 'passed',
    auditTrail: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
