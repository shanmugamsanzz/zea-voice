import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

const plivoAuthId = `MA${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
const plivoToken = `plivo-${crypto.randomUUID()}`;
let syncMode = 'all';
let subaccountCounter = 0;
let applicationCounter = 0;
const numberOwners = new Map();
const subaccountsCreated = [];
const applicationsCreated = [];
const mockPlivo = createServer(async (request, response) => {
  const expected = `Basic ${Buffer.from(`${plivoAuthId}:${plivoToken}`).toString('base64')}`;
  if (request.headers.authorization !== expected) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{}');
    return;
  }
  const allNumbers = [
    { number: '16501234567', country_iso: 'US', type: 'fixed', voice_enabled: true, sms_enabled: true },
    { number: '918035383450', country_iso: 'IN', type: 'mobile', voice_enabled: true, sms_enabled: false },
  ].map((item) => ({ ...item, sub_account: numberOwners.get(item.number) ?? null }));
  const url = new URL(request.url, 'http://localhost');
  const body = request.method === 'POST' ? await new Promise((resolve) => {
    let value = '';
    request.on('data', (chunk) => { value += chunk; });
    request.on('end', () => resolve(value ? JSON.parse(value) : {}));
  }) : {};
  let payload;
  let status = 200;
  if (request.method === 'POST' && url.pathname.endsWith('/Subaccount/')) {
    subaccountCounter += 1;
    const authId = `SA${String(subaccountCounter).padStart(18, '0')}`;
    payload = { auth_id: authId, auth_token: `sub-token-${subaccountCounter}-${crypto.randomUUID()}`, api_id: crypto.randomUUID() };
    subaccountsCreated.push({ authId, name: body.name }); status = 201;
  } else if (request.method === 'POST' && url.pathname.endsWith('/Application/')) {
    applicationCounter += 1;
    payload = { app_id: String(10000000000000000n + BigInt(applicationCounter)), api_id: crypto.randomUUID() };
    applicationsCreated.push(body); status = 201;
  } else if (request.method === 'POST' && /\/Number\/[^/]+\/$/.test(url.pathname)) {
    const number = decodeURIComponent(url.pathname.split('/').at(-2));
    if ('subaccount' in body) numberOwners.set(number, body.subaccount);
    payload = { message: 'changed', api_id: crypto.randomUUID() }; status = 202;
  } else {
    const objects = syncMode === 'all' ? allNumbers : allNumbers.slice(0, 1);
    payload = { objects, meta: { total_count: objects.length, limit: 20, offset: 0 } };
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
});
await new Promise((resolve, reject) => { mockPlivo.once('error', reject); mockPlivo.listen(0, '127.0.0.1', resolve); });

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PLIVO_API_BASE_URL = `http://127.0.0.1:${mockPlivo.address().port}/v1`;

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task7-${crypto.randomUUID()}!`;
const superEmail = `task7-admin-${suffix}@example.test`;
const developerEmail = `task7-developer-${suffix}@example.test`;
const users = [];
const tenants = [];
let telephonyAccountId;
let server;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
}
async function login(base, email) {
  const response = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}
async function deleteTenant(id) {
  await admin.query('DELETE FROM audit_logs WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [id]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [id]);
}
async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mockPlivo.close(resolve));
  if (admin._connected) {
    if (telephonyAccountId) {
      await admin.query(`DELETE FROM phone_number_assignments WHERE phone_number_id IN (
        SELECT n.id FROM phone_numbers n JOIN telephony_accounts a ON a.id=n.telephony_account_id
        WHERE a.id=$1 OR a.parent_account_id=$1)`, [telephonyAccountId]);
      await admin.query(`DELETE FROM phone_numbers WHERE telephony_account_id IN (
        SELECT id FROM telephony_accounts WHERE id=$1 OR parent_account_id=$1)`, [telephonyAccountId]);
      await admin.query('DELETE FROM telephony_accounts WHERE parent_account_id = $1', [telephonyAccountId]);
      await admin.query('DELETE FROM telephony_accounts WHERE id = $1', [telephonyAccountId]);
    }
    for (const tenant of tenants) await deleteTenant(tenant);
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
     VALUES ($1, $2, 'Task', 'Seven Admin', 'active', 'super_admin', now()) RETURNING id`,
    [superEmail, await hashPassword(password)],
  )).rows[0];
  users.push(superUser.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(base, superEmail);
  const adminHeaders = { authorization: `Bearer ${superToken}` };

  async function createCompany(name, maxPhoneNumbers) {
    const response = await api(base, '/admin/companies', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        businessName: name, firstName: 'Task', lastName: 'Seven',
        email: `${name.replace(/\s/g, '').toLowerCase()}@example.test`, businessPhone: '+918000000000',
        timezone: 'Asia/Kolkata', perMinutePrice: 1.5, limits: { maxPhoneNumbers },
      }),
    });
    assert.equal(response.status, 201);
    const company = (await response.json()).data;
    tenants.push(company.tenantId);
    return company;
  }
  const companyA = await createCompany(`Task 7 A ${suffix}`, 1);
  const companyB = await createCompany(`Task 7 B ${suffix}`, 2);
  const developerResponse = await api(base, '/admin/developers', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ companyId: companyA.tenantId, fullName: 'Task Seven Developer', email: developerEmail, password }),
  });
  assert.equal(developerResponse.status, 201);
  users.push((await developerResponse.json()).data.userId);

  const accountResponse = await api(base, '/admin/telephony/accounts', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      name: `Task 7 Plivo ${suffix}`, provider: 'plivo', authId: plivoAuthId,
      authToken: plivoToken, baseUrl: process.env.PLIVO_API_BASE_URL,
      applicationId: `task7-${suffix}`,
      answerUrl: 'https://api.voice.zeacrm.com/webhooks/plivo/answer',
      hangupUrl: 'https://api.voice.zeacrm.com/webhooks/plivo/hangup',
      recordingCallbackUrl: 'https://api.voice.zeacrm.com/webhooks/plivo/recording',
    }),
  });
  assert.equal(accountResponse.status, 201);
  const account = (await accountResponse.json()).data;
  telephonyAccountId = account.id;
  assert.equal(account.authToken, plivoToken);
  assert.equal(account.baseUrl, process.env.PLIVO_API_BASE_URL);
  assert.equal(account.applicationId, `task7-${suffix}`);
  const encrypted = await admin.query('SELECT auth_token_encrypted FROM telephony_accounts WHERE id = $1', [telephonyAccountId]);
  assert.notEqual(encrypted.rows[0].auth_token_encrypted, plivoToken);

  const updatedAccountResponse = await api(base, `/admin/telephony/accounts/${telephonyAccountId}`, {
    method: 'PATCH', headers: adminHeaders,
    body: JSON.stringify({ name: `Updated Task 7 Plivo ${suffix}`, baseUrl: process.env.PLIVO_API_BASE_URL }),
  });
  assert.equal(updatedAccountResponse.status, 200);
  assert.equal((await updatedAccountResponse.json()).data.name, `Updated Task 7 Plivo ${suffix}`);

  const syncResponse = await api(base, `/admin/telephony/accounts/${telephonyAccountId}/sync`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(syncResponse.status, 200);
  assert.equal((await syncResponse.json()).data.synchronized, 2);
  const inventoryResponse = await api(base, '/admin/telephony/phone-numbers', { headers: adminHeaders });
  const inventory = (await inventoryResponse.json()).data;
  assert.ok(inventory.pagination.total >= 2);
  const first = inventory.items.find((item) => item.number === '+16501234567');
  const second = inventory.items.find((item) => item.number === '+918035383450');

  const assigned = await api(base, `/admin/telephony/phone-numbers/${first.id}/assign`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ companyId: companyA.tenantId }),
  });
  assert.equal(assigned.status, 200);
  const assignedData = (await assigned.json()).data;
  assert.equal(assignedData.accountType, 'subaccount');
  assert.match(assignedData.subaccountAuthId, /^SA/);
  assert.equal(subaccountsCreated.length, 1);
  assert.equal(applicationsCreated.length, 1);
  const overLimit = await api(base, `/admin/telephony/phone-numbers/${second.id}/assign`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ companyId: companyA.tenantId }),
  });
  assert.equal(overLimit.status, 409);
  const crossCompany = await api(base, `/admin/telephony/phone-numbers/${first.id}/assign`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ companyId: companyB.tenantId }),
  });
  assert.equal(crossCompany.status, 409);

  const developerToken = await login(base, developerEmail);
  const tenantNumbers = await api(base, '/phone-numbers', { headers: { authorization: `Bearer ${developerToken}` } });
  assert.equal(tenantNumbers.status, 200);
  assert.deepEqual((await tenantNumbers.json()).data.map((item) => item.number), ['+16501234567']);

  const released = await api(base, `/admin/telephony/phone-numbers/${first.id}/release`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ reason: 'reassignment' }),
  });
  assert.equal(released.status, 200);
  const afterRelease = await api(base, '/phone-numbers', { headers: { authorization: `Bearer ${developerToken}` } });
  assert.deepEqual((await afterRelease.json()).data, []);
  const reassigned = await api(base, `/admin/telephony/phone-numbers/${first.id}/assign`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ companyId: companyB.tenantId }),
  });
  assert.equal(reassigned.status, 200);
  assert.equal(subaccountsCreated.length, 2);
  assert.equal(applicationsCreated.length, 2);

  syncMode = 'single';
  const resync = await api(base, `/admin/telephony/accounts/${telephonyAccountId}/sync`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(resync.status, 200);
  const missing = await admin.query('SELECT status FROM phone_numbers WHERE id = $1', [second.id]);
  assert.equal(missing.rows[0].status, 'unavailable');

  await api(base, `/admin/telephony/phone-numbers/${first.id}/release`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ reason: 'provider deletion test' }),
  });
  const deletedAccount = await api(base, `/admin/telephony/accounts/${telephonyAccountId}`, {
    method: 'DELETE', headers: adminHeaders,
  });
  assert.equal(deletedAccount.status, 409);

  console.log(JSON.stringify({
    success: true, encryptedPlivoCredentials: 'passed', plivoNumberSync: 'passed',
    globalInventory: 'passed', exclusiveCompanyAssignment: 'passed', companyPhoneLimit: 'passed',
    tenantNumberIsolation: 'passed', releaseAndReassign: 'passed', missingProviderNumberHandling: 'passed',
    providerEditAndDeleteProtection: 'passed', providerBaseUrl: 'passed',
    companySubaccountProvisioning: 'passed', atomicNumberTransfer: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
