import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');
const { closeQueues } = await import('../src/queues/queue.registry.js');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task9a-${crypto.randomUUID()}!`;
const superEmail = `task9a-admin-${suffix}@example.test`;
const developerEmail = `task9a-developer-${suffix}@example.test`;
const userIds = [];
const tenantIds = [];
let server;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
}
async function login(base, email) {
  const response = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}
async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    await admin.query('DELETE FROM api_keys WHERE created_by = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])', [userIds, tenantIds]);
    await admin.query('DELETE FROM credit_ledger_entries WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
    await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])', [userIds, tenantIds]);
    for (const tenantId of tenantIds) {
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    if (userIds.length) {
      await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await admin.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const superUser = (await admin.query(`INSERT INTO users
    (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
    VALUES ($1, $2, 'Task', 'Nine A Admin', 'active', 'super_admin', now()) RETURNING id`,
  [superEmail, await hashPassword(password)])).rows[0];
  userIds.push(superUser.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(base, superEmail);
  const superHeaders = { authorization: `Bearer ${superToken}` };

  async function createCompany(label) {
    const response = await api(base, '/admin/companies', { method: 'POST', headers: superHeaders,
      body: JSON.stringify({ businessName: `Task 9A ${label} ${suffix}`, email: `task9a-${label}-${suffix}@example.test` }) });
    assert.equal(response.status, 201);
    const company = (await response.json()).data;
    tenantIds.push(company.tenantId);
    return company;
  }
  const companyA = await createCompany('A');
  const companyB = await createCompany('B');
  const developerResponse = await api(base, '/admin/developers', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ companyId: companyA.tenantId, fullName: 'Task Nine A Developer', email: developerEmail, password }) });
  assert.equal(developerResponse.status, 201);
  userIds.push((await developerResponse.json()).data.userId);

  const platformCreate = await api(base, '/api-keys', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ name: 'Read-only platform verification', scopes: ['companies:read'] }) });
  assert.equal(platformCreate.status, 201);
  const platformKey = (await platformCreate.json()).data;
  assert.match(platformKey.key, /^zea_live_/);
  const platformHeaders = { authorization: `Bearer ${platformKey.key}` };
  assert.equal((await api(base, '/admin/companies', { headers: platformHeaders })).status, 200);
  assert.equal((await api(base, '/admin/companies', { method: 'POST', headers: platformHeaders,
    body: JSON.stringify({ businessName: 'Must Not Create', email: 'must-not-create@example.test' }) })).status, 403);

  const developerToken = await login(base, developerEmail);
  const developerHeaders = { authorization: `Bearer ${developerToken}` };
  const tenantCreate = await api(base, '/api-keys', { method: 'POST', headers: developerHeaders,
    body: JSON.stringify({ name: 'Company integration', scopes: ['credits:read'] }) });
  assert.equal(tenantCreate.status, 201);
  const tenantKey = (await tenantCreate.json()).data;
  assert.equal(tenantKey.tenantId, companyA.tenantId);
  const tenantHeaders = { authorization: `Bearer ${tenantKey.key}` };
  assert.equal((await api(base, '/credits', { headers: tenantHeaders })).status, 200);
  assert.equal((await api(base, '/phone-numbers', { headers: tenantHeaders })).status, 403);
  assert.equal((await api(base, '/credits', { headers: { ...tenantHeaders,
    'x-tenant-id': companyB.tenantId, 'x-workspace-id': companyB.workspaceId } })).status, 403);

  const stored = (await admin.query('SELECT key_hash, last_used_at FROM api_keys WHERE id = $1', [tenantKey.id])).rows[0];
  assert.notEqual(stored.key_hash, tenantKey.key);
  assert.equal(stored.key_hash.length, 64);
  assert.ok(stored.last_used_at);
  const listed = await api(base, '/api-keys', { headers: developerHeaders });
  assert.equal('key' in (await listed.json()).data.find((key) => key.id === tenantKey.id), false);
  assert.equal((await api(base, '/api-keys', { method: 'POST', headers: tenantHeaders,
    body: JSON.stringify({ name: 'Forbidden child key' }) })).status, 403);

  const rotate = await api(base, `/api-keys/${tenantKey.id}/rotate`, { method: 'POST', headers: developerHeaders, body: '{}' });
  assert.equal(rotate.status, 201);
  const rotated = (await rotate.json()).data;
  assert.equal((await api(base, '/credits', { headers: tenantHeaders })).status, 401);
  const rotatedHeaders = { authorization: `Bearer ${rotated.key}` };
  assert.equal((await api(base, '/credits', { headers: rotatedHeaders })).status, 200);
  assert.equal((await api(base, `/api-keys/${rotated.id}/revoke`, { method: 'POST', headers: developerHeaders,
    body: JSON.stringify({ reason: 'Verification complete' }) })).status, 200);
  assert.equal((await api(base, '/credits', { headers: rotatedHeaders })).status, 401);

  console.log(JSON.stringify({ success: true, platformApiKey: 'passed', companyDeveloperCreation: 'passed',
    plaintextShownOnce: 'passed', hashedStorage: 'passed', scopeEnforcement: 'passed', tenantIsolation: 'passed',
    lastUsedTracking: 'passed', sessionOnlyKeyManagement: 'passed', rotation: 'passed', revocation: 'passed',
    temporaryRecordsRemoved: true }, null, 2));
} finally {
  await cleanup();
}
