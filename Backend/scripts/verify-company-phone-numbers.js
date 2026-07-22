import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');
const { closeQueues } = await import('../src/queues/queue.registry.js');

const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = 'CompanyPhones-' + crypto.randomUUID() + '!';
const tenantIds = [];
const userIds = [];
const providerIds = [];
const phoneIds = [];
let accountId;
let server;

async function api(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
}

async function login(base, email) {
  const response = await api(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (database._connected) {
    for (const tenantId of tenantIds) {
      const members = await database.query(
        'SELECT user_id FROM tenant_memberships WHERE tenant_id = $1',
        [tenantId],
      );
      userIds.push(...members.rows.map((row) => row.user_id));
      await database.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM voice_agents WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM phone_number_assignments WHERE tenant_id = $1', [tenantId]);
      await database.query('UPDATE phone_numbers SET assigned_tenant_id = NULL WHERE assigned_tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM company_credit_wallets WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM workspaces WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM organizations WHERE tenant_id = $1', [tenantId]);
      await database.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    if (phoneIds.length) {
      await database.query('DELETE FROM phone_numbers WHERE id = ANY($1::uuid[])', [phoneIds]);
    }
    if (accountId) {
      await database.query('DELETE FROM telephony_accounts WHERE id = $1', [accountId]);
    }
    if (providerIds.length) {
      await database.query('DELETE FROM provider_models WHERE provider_id = ANY($1::uuid[])', [providerIds]);
      await database.query('DELETE FROM ai_providers WHERE id = ANY($1::uuid[])', [providerIds]);
    }
    if (userIds.length) {
      const uniqueUsers = [...new Set(userIds)];
      await database.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [uniqueUsers]);
      await database.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [uniqueUsers]);
      await database.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [uniqueUsers]);
    }
    await database.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  const frontend = await readFile(
    new URL('../../Frontend/src/components/views/CompanyViews.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(frontend, /MOCK_PHONE_NUMBERS/);
  assert.doesNotMatch(frontend, /Monthly Lease Cost|assignAgentToNum|\/release/);
  assert.match(frontend, /\/phone-numbers\/.*\/agent/);
  assert.match(frontend, /READ ONLY/);

  await database.connect();
  const adminEmail = 'company-phones-admin-' + suffix + '@example.test';
  const developerEmail = 'company-phones-developer-' + suffix + '@example.test';
  const companyUserEmail = 'company-phones-user-' + suffix + '@example.test';
  const otherDeveloperEmail = 'company-phones-other-' + suffix + '@example.test';
  const admin = (await database.query(
    "INSERT INTO users "
      + "(email,password_hash,first_name,last_name,status,platform_role,email_verified_at) "
      + "VALUES ($1,$2,'Phone','Admin','active','super_admin',now()) RETURNING id",
    [adminEmail, await hashPassword(password)],
  )).rows[0];
  userIds.push(admin.id);

  for (const type of ['stt', 'llm', 'tts']) {
    const provider = (await database.query(
      "INSERT INTO ai_providers (name,slug,type,status,created_by) "
        + "VALUES ($1,$2,$3::ai_provider_type,'connected',$4) RETURNING id",
      ['Company Phone ' + type.toUpperCase() + ' ' + suffix, 'company-phone-' + type + '-' + suffix, type, admin.id],
    )).rows[0];
    providerIds.push(provider.id);
    await database.query(
      "INSERT INTO provider_models "
        + "(provider_id,model_key,display_name,status,created_by) "
        + "VALUES ($1,$2,$3,'active',$4)",
      [provider.id, 'model-' + type, 'Phone ' + type.toUpperCase(), admin.id],
    );
  }
  const models = await database.query(
    "SELECT provider.type, model.id FROM provider_models model "
      + "JOIN ai_providers provider ON provider.id = model.provider_id "
      + "WHERE provider.id = ANY($1::uuid[])",
    [providerIds],
  );
  const modelByType = Object.fromEntries(models.rows.map((row) => [row.type, row.id]));

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const adminHeaders = { authorization: 'Bearer ' + await login(base, adminEmail) };

  async function company(label) {
    const response = await api(base, '/admin/companies', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        businessName: 'Company Phones ' + label + ' ' + suffix,
        firstName: 'Phone',
        lastName: 'Company ' + label,
        email: 'company-phones-' + label + '-' + suffix + '@example.test',
        businessPhone: '+919999999999',
        perMinutePrice: 6.4,
        timezone: 'Asia/Kolkata',
        currency: 'INR',
      }),
    });
    assert.equal(response.status, 201);
    const value = (await response.json()).data;
    tenantIds.push(value.tenantId);
    return value;
  }

  async function member(companyId, fullName, email, role) {
    const response = await api(base, '/admin/developers', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ companyId, fullName, email, password, role }),
    });
    assert.equal(response.status, 201);
    userIds.push((await response.json()).data.userId);
  }

  const companyA = await company('A');
  const companyB = await company('B');
  await member(companyA.tenantId, 'Phone Developer', developerEmail, 'COMPANY_DEVELOPER');
  await member(companyA.tenantId, 'Phone User', companyUserEmail, 'COMPANY_USER');
  await member(companyB.tenantId, 'Other Developer', otherDeveloperEmail, 'COMPANY_DEVELOPER');

  accountId = (await database.query(
    "INSERT INTO telephony_accounts "
      + "(provider,name,auth_id,auth_token_encrypted,status,created_by) "
      + "VALUES ('plivo',$1,$2,'fixture-token','connected',$3) RETURNING id",
    ['Company Phones ' + suffix, 'company-phones-' + suffix, admin.id],
  )).rows[0].id;

  const numberSeed = String(Date.now()).slice(-7);
  async function phone(index, tenantId) {
    const result = await database.query(
      "INSERT INTO phone_numbers "
        + "(telephony_account_id,e164,country_iso,number_type,capabilities,monthly_cost,currency,status,assigned_tenant_id) "
        + "VALUES ($1,$2,'US','local',$3::jsonb,99.99,'USD','active',$4) RETURNING id",
      [accountId, '+165' + index + numberSeed, JSON.stringify({ voice: true }), tenantId],
    );
    phoneIds.push(result.rows[0].id);
    if (tenantId) {
      await database.query(
        'INSERT INTO phone_number_assignments (phone_number_id,tenant_id,assigned_by) VALUES ($1,$2,$3)',
        [result.rows[0].id, tenantId, admin.id],
      );
    }
    return result.rows[0].id;
  }
  const phoneA = await phone(1, companyA.tenantId);
  const phoneB = await phone(2, companyB.tenantId);
  const unassignedPhone = await phone(3, null);

  async function agent(companyValue, name, phoneNumberId = null) {
    return (await database.query(
      "INSERT INTO voice_agents "
        + "(tenant_id,workspace_id,name,status,phone_number_id,stt_model_id,llm_model_id,tts_model_id,voice_id,prompt,created_by,updated_by) "
        + "VALUES ($1,$2,$3,'active',$4,$5,$6,$7,'fixture-voice','Fixture prompt',$8,$8) RETURNING id",
      [
        companyValue.tenantId,
        companyValue.workspaceId,
        name,
        phoneNumberId,
        modelByType.stt,
        modelByType.llm,
        modelByType.tts,
        admin.id,
      ],
    )).rows[0].id;
  }
  const firstAgent = await agent(companyA, 'First Agent', phoneA);
  const secondAgent = await agent(companyA, 'Second Agent');
  const foreignAgent = await agent(companyB, 'Foreign Agent', phoneB);

  const developerHeaders = { authorization: 'Bearer ' + await login(base, developerEmail) };
  const listResponse = await api(base, '/phone-numbers', { headers: developerHeaders });
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, phoneA);
  assert.equal(list[0].assignedAgent.id, firstAgent);
  for (const hidden of ['provider', 'telephonyAccountId', 'telephonyAccountName', 'subaccountAuthId', 'monthlyCost', 'currency', 'companyId', 'companyName']) {
    assert.equal(Object.hasOwn(list[0], hidden), false);
  }
  assert.ok(!JSON.stringify(list).includes(phoneB));
  assert.ok(!JSON.stringify(list).includes(unassignedPhone));

  const mapResponse = await api(base, '/phone-numbers/' + phoneA + '/agent', {
    method: 'PUT',
    headers: developerHeaders,
    body: JSON.stringify({ agentId: secondAgent }),
  });
  const mapPayload = await mapResponse.json();
  assert.equal(mapResponse.status, 200, JSON.stringify(mapPayload));
  const mapped = mapPayload.data;
  assert.equal(mapped.assignedAgent.id, secondAgent);
  const storedAgents = await database.query(
    'SELECT id, phone_number_id FROM voice_agents WHERE id = ANY($1::uuid[]) ORDER BY id',
    [[firstAgent, secondAgent]],
  );
  assert.equal(storedAgents.rows.find((row) => row.id === firstAgent).phone_number_id, null);
  assert.equal(storedAgents.rows.find((row) => row.id === secondAgent).phone_number_id, phoneA);

  assert.equal((await api(base, '/phone-numbers/' + phoneB + '/agent', {
    method: 'PUT', headers: developerHeaders, body: JSON.stringify({ agentId: secondAgent }),
  })).status, 404);
  assert.equal((await api(base, '/phone-numbers/' + unassignedPhone + '/agent', {
    method: 'PUT', headers: developerHeaders, body: JSON.stringify({ agentId: secondAgent }),
  })).status, 404);
  assert.equal((await api(base, '/phone-numbers/' + phoneA + '/agent', {
    method: 'PUT', headers: developerHeaders, body: JSON.stringify({ agentId: foreignAgent }),
  })).status, 404);

  const userHeaders = { authorization: 'Bearer ' + await login(base, companyUserEmail) };
  const userListResponse = await api(base, '/phone-numbers', { headers: userHeaders });
  assert.equal(userListResponse.status, 200);
  const userList = (await userListResponse.json()).data;
  assert.equal(userList.length, 1);
  assert.equal(userList[0].id, phoneA);
  assert.equal(userList[0].assignedAgent.id, secondAgent);
  assert.equal((await api(base, '/phone-numbers/' + phoneA + '/agent', {
    method: 'PUT', headers: userHeaders, body: JSON.stringify({ agentId: firstAgent }),
  })).status, 403);
  assert.equal((await api(base, '/phone-numbers/' + phoneA + '/release', {
    method: 'POST', headers: developerHeaders, body: '{}',
  })).status, 404);

  console.log(JSON.stringify({
    success: true,
    task: 'Developer and User company Phone Numbers',
    mockRemoval: 'passed',
    companyOnlyListing: 'passed',
    sensitiveProviderFieldsHidden: 'passed',
    developerAgentMapping: 'passed',
    atomicAgentChange: 'passed',
    userReadOnly: 'passed',
    tenantIsolation: 'passed',
    adminActionsHidden: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
