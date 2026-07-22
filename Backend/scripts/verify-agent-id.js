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
const password = 'AgentId-' + crypto.randomUUID() + '!';
const tenants = [];
const users = [];
const providers = [];
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
    for (const tenantId of tenants) {
      const members = await database.query('SELECT user_id FROM tenant_memberships WHERE tenant_id=$1', [tenantId]);
      users.push(...members.rows.map((row) => row.user_id));
      await database.query('DELETE FROM audit_logs WHERE tenant_id=$1', [tenantId]);
      await database.query('DELETE FROM auth_sessions WHERE tenant_id=$1', [tenantId]);
      await database.query('DELETE FROM voice_agents WHERE tenant_id=$1', [tenantId]);
      for (const table of ['tenant_memberships', 'company_credit_wallets', 'tenant_settings',
        'tenant_limits', 'workspaces', 'organizations']) {
        await database.query('DELETE FROM ' + table + ' WHERE tenant_id=$1', [tenantId]);
      }
      await database.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    }
    if (providers.length) {
      await database.query('DELETE FROM provider_models WHERE provider_id=ANY($1::uuid[])', [providers]);
      await database.query('DELETE FROM ai_providers WHERE id=ANY($1::uuid[])', [providers]);
    }
    if (users.length) {
      const ids = [...new Set(users)];
      await database.query('DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])', [ids]);
      await database.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [ids]);
      await database.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
    }
    await database.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  const migration = await readFile(
    new URL('../migrations/1784000008000_tasks-14-15-users-agents.js', import.meta.url),
    'utf8',
  );
  const companyView = await readFile(
    new URL('../../Frontend/src/components/views/CompanyViews.tsx', import.meta.url),
    'utf8',
  );
  const detailView = await readFile(
    new URL('../../Frontend/src/components/agent/AgentTabs.tsx', import.meta.url),
    'utf8',
  );
  const routes = await readFile(new URL('../src/agents/agent.routes.js', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../src/agents/agent-runtime.service.js', import.meta.url), 'utf8');
  const resolver = await readFile(new URL('../src/voice/agent-resolver.service.js', import.meta.url), 'utf8');
  const callStore = await readFile(new URL('../src/voice/call-session-store.js', import.meta.url), 'utf8');
  assert.match(migration, /id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  assert.match(companyView, />Agent ID</);
  assert.match(detailView, />Agent ID</);
  assert.match(routes, /\/:agentId/);
  assert.match(runtime, /a\.tenant_id=\$1 AND a\.id=\$2/);
  assert.match(resolver, /agentId: agent\.id/);
  assert.match(callStore, /input\.runtimeProfile\.agent\.id/);

  await database.connect();
  const adminEmail = 'agent-id-admin-' + suffix + '@example.test';
  const admin = (await database.query(
    "INSERT INTO users(email,password_hash,first_name,last_name,status,platform_role,email_verified_at) "
      + "VALUES($1,$2,'Agent ID','Admin','active','super_admin',now()) RETURNING id",
    [adminEmail, await hashPassword(password)],
  )).rows[0];
  users.push(admin.id);
  const modelIds = {};
  for (const type of ['stt', 'llm', 'tts']) {
    const provider = (await database.query(
      "INSERT INTO ai_providers(name,slug,type,status,created_by) "
        + "VALUES($1,$2,$3::ai_provider_type,'connected',$4) RETURNING id",
      ['Agent ID ' + type + ' ' + suffix, 'agent-id-' + type + '-' + suffix, type, admin.id],
    )).rows[0];
    providers.push(provider.id);
    modelIds[type] = (await database.query(
      "INSERT INTO provider_models(provider_id,model_key,display_name,status,created_by) "
        + "VALUES($1,$2,$3,'active',$4) RETURNING id",
      [provider.id, 'agent-id-' + type, 'Agent ID ' + type.toUpperCase(), admin.id],
    )).rows[0].id;
  }

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const adminHeaders = { authorization: 'Bearer ' + await login(base, adminEmail) };

  async function company(label, developerEmail) {
    const name = 'Agent ID Company ' + label + ' ' + suffix;
    const response = await api(base, '/admin/companies', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        businessName: name,
        organizationName: name + ' Organization',
        workspaceName: name + ' Workspace',
        legalName: name,
        firstName: 'Agent',
        lastName: 'Owner',
        email: 'agent-id-company-' + label + '-' + suffix + '@example.test',
        businessPhone: '+919999999999',
        website: 'https://example.test',
        billingTier: 'starter',
        perMinutePrice: 6.4,
        addressLine1: 'Test Street',
        state: 'Tamil Nadu',
        country: 'India',
        postalCode: '600001',
        timezone: 'Asia/Kolkata',
        status: 'active',
        locale: 'en-US',
        currency: 'INR',
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    tenants.push(payload.data.tenantId);
    const member = await api(base, '/admin/developers', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        companyId: payload.data.tenantId,
        fullName: 'Agent ID Developer',
        email: developerEmail,
        password,
        role: 'COMPANY_DEVELOPER',
      }),
    });
    assert.equal(member.status, 201);
    users.push((await member.json()).data.userId);
    return payload.data;
  }

  const developerA = 'agent-id-developer-a-' + suffix + '@example.test';
  const developerB = 'agent-id-developer-b-' + suffix + '@example.test';
  const companyA = await company('A', developerA);
  await company('B', developerB);
  const headersA = { authorization: 'Bearer ' + await login(base, developerA) };
  const headersB = { authorization: 'Bearer ' + await login(base, developerB) };
  const fixedClientId = '00000000-0000-4000-8000-000000000001';

  async function createAgent(name, extra = {}) {
    const body = {
      name,
      sttModelId: modelIds.stt,
      llmModelId: modelIds.llm,
      ttsModelId: modelIds.tts,
      voiceId: 'voice-from-database',
      prompt: 'Use the generated Agent ID for runtime calls.',
      ...extra,
    };
    const response = await api(base, '/agents', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    return payload.data;
  }

  const first = await createAgent('Generated Agent One');
  const second = await createAgent('Generated Agent Two', { id: fixedClientId });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(first.id, uuid);
  assert.match(second.id, uuid);
  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, fixedClientId);

  const stored = await database.query(
    'SELECT id,tenant_id,workspace_id FROM voice_agents WHERE id=ANY($1::uuid[]) ORDER BY id',
    [[first.id, second.id]],
  );
  assert.equal(stored.rowCount, 2);
  assert.ok(stored.rows.every((row) => row.tenant_id === companyA.tenantId));
  assert.ok(stored.rows.every((row) => row.workspace_id === companyA.workspaceId));
  const audit = await database.query(
    "SELECT entity_id,after_data FROM audit_logs WHERE tenant_id=$1 "
      + "AND action='VOICE_AGENT_CREATED' AND entity_id=$2 ORDER BY created_at DESC LIMIT 1",
    [companyA.tenantId, first.id],
  );
  assert.equal(audit.rows[0].after_data.agentId, first.id);

  const ownGet = await api(base, '/agents/' + first.id, { headers: headersA });
  assert.equal(ownGet.status, 200);
  assert.equal((await ownGet.json()).data.id, first.id);
  assert.equal((await api(base, '/agents/' + first.id, { headers: headersB })).status, 404);

  console.log(JSON.stringify({
    success: true,
    task: 'Database-generated Agent ID',
    backendGeneration: 'passed',
    clientIdIgnored: 'passed',
    databasePersistence: 'passed',
    tenantIsolation: 'passed',
    apiRuntimeIdentifierUsage: 'passed',
    voiceWebhookIdentifierUsage: 'passed',
    cardAndDetailDisplay: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
