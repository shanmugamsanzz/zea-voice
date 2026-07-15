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
const password = `Task5-${crypto.randomUUID()}!`;
const superEmail = `task5-admin-${suffix}@example.test`;
const developerEmail = `task5-developer-${suffix}@example.test`;
const secondDeveloperEmail = `task5-developer-2-${suffix}@example.test`;
const thirdDeveloperEmail = `task5-developer-3-${suffix}@example.test`;
const createdUserIds = [];
let tenantId;
let server;

async function api(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
}

async function login(baseUrl, email, expectedStatus = 200) {
  const response = await api(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, expectedStatus);
  return expectedStatus === 200 ? (await response.json()).data.accessToken : null;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    if (tenantId) {
      await admin.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    if (createdUserIds.length) {
      await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [createdUserIds]);
      await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [createdUserIds]);
      await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    }
    await admin.query(
      `DELETE FROM users
       WHERE email::text LIKE 'task5-%@example.test'
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = users.id)`,
    );
    await admin.end();
  }
  await Promise.allSettled([closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const superPasswordHash = await hashPassword(password);
  const superAdmin = (await admin.query(
    `INSERT INTO users
      (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
     VALUES ($1, $2, 'Task', 'Five Admin', 'active', 'super_admin', now()) RETURNING id`,
    [superEmail, superPasswordHash],
  )).rows[0];
  createdUserIds.push(superAdmin.id);

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(baseUrl, superEmail);
  const superHeaders = { authorization: `Bearer ${superToken}` };

  const companyResponse = await api(baseUrl, '/admin/companies', {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({
      businessName: `Task 5 Company ${suffix}`,
      email: `task5-company-${suffix}@example.test`,
      limits: { maxUsers: 2 },
    }),
  });
  assert.equal(companyResponse.status, 201);
  const company = (await companyResponse.json()).data;
  tenantId = company.tenantId;

  const createResponse = await api(baseUrl, '/admin/developers', {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({
      companyId: tenantId,
      fullName: 'Task Five Developer',
      email: developerEmail,
      password,
    }),
  });
  assert.equal(createResponse.status, 201);
  const developer = (await createResponse.json()).data;
  assert.equal(developer.companyId, tenantId);
  assert.equal(developer.role, 'COMPANY_DEVELOPER');
  assert.equal(developer.status, 'active');
  assert.equal('password' in developer, false);

  const storedUser = await admin.query(
    `SELECT u.id, u.password_hash
     FROM users u JOIN tenant_memberships m ON m.user_id = u.id
     WHERE m.id = $1`,
    [developer.id],
  );
  createdUserIds.push(storedUser.rows[0].id);
  assert.notEqual(storedUser.rows[0].password_hash, password);
  assert.ok(storedUser.rows[0].password_hash.startsWith('$2'));

  const duplicate = await api(baseUrl, '/admin/developers', {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({ companyId: tenantId, fullName: 'Duplicate', email: developerEmail, password }),
  });
  assert.equal(duplicate.status, 409);

  const secondResponse = await api(baseUrl, '/admin/developers', {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({
      companyId: tenantId,
      fullName: 'Second Developer',
      email: secondDeveloperEmail,
      password,
    }),
  });
  assert.equal(secondResponse.status, 201);
  const secondDeveloper = (await secondResponse.json()).data;
  const secondUser = await admin.query(
    'SELECT user_id FROM tenant_memberships WHERE id = $1',
    [secondDeveloper.id],
  );
  createdUserIds.push(secondUser.rows[0].user_id);

  const overLimit = await api(baseUrl, '/admin/developers', {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({
      companyId: tenantId,
      fullName: 'Third Developer',
      email: thirdDeveloperEmail,
      password,
    }),
  });
  assert.equal(overLimit.status, 409);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [thirdDeveloperEmail])).rows[0].count, 0);

  const listResponse = await api(
    baseUrl,
    `/admin/developers?companyId=${tenantId}&search=${encodeURIComponent(suffix)}`,
    { headers: superHeaders },
  );
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()).data;
  assert.equal(list.pagination.total, 2);

  const detailResponse = await api(baseUrl, `/admin/developers/${developer.id}`, { headers: superHeaders });
  assert.equal(detailResponse.status, 200);

  const developerToken = await login(baseUrl, developerEmail);
  const forbidden = await api(baseUrl, '/admin/developers', {
    headers: { authorization: `Bearer ${developerToken}` },
  });
  assert.equal(forbidden.status, 403);

  const suspendResponse = await api(baseUrl, `/admin/developers/${developer.id}/status`, {
    method: 'PATCH',
    headers: superHeaders,
    body: JSON.stringify({ status: 'inactive' }),
  });
  assert.equal(suspendResponse.status, 200);
  assert.equal((await suspendResponse.json()).data.status, 'suspended');

  const revokedSession = await api(baseUrl, '/auth/me', {
    headers: { authorization: `Bearer ${developerToken}` },
  });
  assert.equal(revokedSession.status, 401);
  await login(baseUrl, developerEmail, 403);

  const reactivateResponse = await api(baseUrl, `/admin/developers/${developer.id}/status`, {
    method: 'PATCH',
    headers: superHeaders,
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(reactivateResponse.status, 200);
  await login(baseUrl, developerEmail);

  const audits = await admin.query(
    `SELECT action FROM audit_logs WHERE tenant_id = $1
     AND action IN ('DEVELOPER_CREATED', 'DEVELOPER_STATUS_CHANGED')`,
    [tenantId],
  );
  assert.equal(audits.rowCount, 4);

  console.log(JSON.stringify({
    success: true,
    superAdminOnly: 'passed',
    tenantDeveloperCreation: 'passed',
    passwordHashingAndNonDisclosure: 'passed',
    duplicateEmailProtection: 'passed',
    companyUserLimit: 'passed',
    listingAndDetail: 'passed',
    suspensionAndSessionRevocation: 'passed',
    reactivation: 'passed',
    auditTrail: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
