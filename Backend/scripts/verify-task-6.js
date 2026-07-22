import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64');

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task6-${crypto.randomUUID()}!`;
const superEmail = `task6-admin-${suffix}@example.test`;
const developerEmail = `task6-developer-${suffix}@example.test`;
const users = [];
let tenantId;
let providerId;
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
    if (providerId) {
      await admin.query('DELETE FROM provider_models WHERE provider_id = $1', [providerId]);
      await admin.query('DELETE FROM ai_provider_parameters WHERE provider_id = $1', [providerId]);
      await admin.query('DELETE FROM ai_providers WHERE id = $1', [providerId]);
    }
    if (tenantId) {
      await admin.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM company_credit_wallets WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    if (users.length) {
      await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [users]);
      await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [users]);
      await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    }
    await admin.end();
  }
  await Promise.allSettled([closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const superUser = (await admin.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
     VALUES ($1, $2, 'Task', 'Six Admin', 'active', 'super_admin', now()) RETURNING id`,
    [superEmail, await hashPassword(password)],
  )).rows[0];
  users.push(superUser.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(base, superEmail);
  const adminHeaders = { authorization: `Bearer ${superToken}` };

  const companyResponse = await api(base, '/admin/companies', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      businessName: `Task 6 Company ${suffix}`,
      firstName: 'Task', lastName: 'Owner',
      email: `task6-company-${suffix}@example.test`,
      businessPhone: '+919999999999', timezone: 'Asia/Kolkata', perMinutePrice: 5.5,
    }),
  });
  assert.equal(companyResponse.status, 201);
  tenantId = (await companyResponse.json()).data.tenantId;
  const developerResponse = await api(base, '/admin/developers', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ companyId: tenantId, fullName: 'Task Six Developer', email: developerEmail, password }),
  });
  assert.equal(developerResponse.status, 201);
  users.push((await developerResponse.json()).data.userId);

  const secret = `secret-${crypto.randomUUID()}`;
  const providerResponse = await api(base, '/admin/providers', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      name: `Task 6 LLM ${suffix}`, type: 'llm', status: 'connected', latencyMs: 120,
      parameters: [
        { key: 'api_key', value: secret, isSecret: true },
        { key: 'region', value: 'us-east', isSecret: false },
      ],
    }),
  });
  assert.equal(providerResponse.status, 201);
  const provider = (await providerResponse.json()).data;
  providerId = provider.id;
  assert.equal(provider.modelCount, 0);
  assert.deepEqual(provider.parameterKeys.map((item) => item.key).sort(), ['api_key', 'region']);
  assert.equal(JSON.stringify(provider).includes(secret), true);
  const stored = await admin.query(
    'SELECT key, plain_value, encrypted_value, is_secret FROM ai_provider_parameters WHERE provider_id = $1 ORDER BY key',
    [providerId],
  );
  const storedSecret = stored.rows.find((row) => row.key === 'api_key');
  assert.equal(storedSecret.plain_value, secret);
  assert.equal(storedSecret.encrypted_value, null);
  assert.equal(storedSecret.is_secret, false);

  const modelResponse = await api(base, `/admin/providers/${providerId}/models`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ modelKey: 'task-6-model', displayName: 'Task 6 Model', capabilities: { chat: true } }),
  });
  assert.equal(modelResponse.status, 201);
  const modelId = (await modelResponse.json()).data.id;

  const updateModelResponse = await api(base, `/admin/providers/models/${modelId}`, {
    method: 'PATCH', headers: adminHeaders,
    body: JSON.stringify({
      modelKey: 'task-6-model-v2', displayName: 'Task 6 Model v2',
      capabilities: { chat: true, streaming: true }, settings: { runtimeAdapter: 'openai' },
    }),
  });
  assert.equal(updateModelResponse.status, 200);
  const updatedModel = (await updateModelResponse.json()).data;
  assert.equal(updatedModel.modelKey, 'task-6-model-v2');
  assert.equal(updatedModel.settings.runtimeAdapter, 'openai');

  const developerToken = await login(base, developerEmail);
  const catalog = await api(base, '/catalog/providers?type=llm', { headers: { authorization: `Bearer ${developerToken}` } });
  assert.equal(catalog.status, 200);
  const catalogItems = (await catalog.json()).data;
  assert.equal(catalogItems.some((item) => item.modelKey === 'task-6-model-v2' && item.providerId === providerId), true);

  const forbidden = await api(base, '/admin/providers', { headers: { authorization: `Bearer ${developerToken}` } });
  assert.equal(forbidden.status, 403);
  const disableModel = await api(base, `/admin/providers/models/${modelId}/status`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'inactive' }),
  });
  assert.equal(disableModel.status, 200);
  const emptyCatalog = await api(base, '/catalog/providers?type=llm', { headers: { authorization: `Bearer ${developerToken}` } });
  const catalogAfterDisable = (await emptyCatalog.json()).data;
  assert.equal(catalogAfterDisable.some((item) => item.id === modelId), false);

  const updatedName = `Task 6 Updated LLM ${suffix}`;
  const updateProvider = await api(base, `/admin/providers/${providerId}`, {
    method: 'PATCH', headers: adminHeaders,
    body: JSON.stringify({
      name: updatedName, status: 'disconnected', baseUrl: 'https://api.example.test', latencyMs: 95,
      parameters: [
        { originalKey: 'api_key', key: 'api_key', isSecret: true },
        { originalKey: 'region', key: 'region_name', isSecret: false },
        { key: 'endpoint_version', value: 'v2', isSecret: false },
      ],
    }),
  });
  const updatedProvider = (await updateProvider.json()).data;
  assert.equal(updateProvider.status, 200);
  assert.equal(updatedProvider.name, updatedName);
  assert.equal(updatedProvider.baseUrl, 'https://api.example.test');
  assert.equal(updatedProvider.latencyMs, 95);
  assert.deepEqual(updatedProvider.parameterKeys.map((item) => item.key).sort(), ['api_key', 'endpoint_version', 'region_name']);
  const preservedSecret = await admin.query(
    `SELECT plain_value, encrypted_value, is_secret FROM ai_provider_parameters WHERE provider_id = $1 AND key = 'api_key'`,
    [providerId],
  );
  assert.equal(preservedSecret.rows[0].plain_value, secret);
  assert.equal(preservedSecret.rows[0].encrypted_value, null);
  assert.equal(preservedSecret.rows[0].is_secret, false);

  const deleteProvider = await api(base, `/admin/providers/${providerId}`, { method: 'DELETE', headers: adminHeaders });
  const deletedProvider = await deleteProvider.json();
  assert.equal(deleteProvider.status, 200, JSON.stringify(deletedProvider));
  assert.equal(deletedProvider.data.deleted, true);
  const providersAfterDelete = await api(base, `/admin/providers?search=${encodeURIComponent(updatedName)}`, { headers: adminHeaders });
  assert.deepEqual((await providersAfterDelete.json()).data, []);

  console.log(JSON.stringify({
    success: true, providerManagement: 'passed', providerEditDelete: 'passed', plaintextAdminParameters: 'passed',
    modelCatalog: 'passed', tenantCatalogVisibility: 'passed', inactiveModelHidden: 'passed',
    superAdminWriteProtection: 'passed', temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
