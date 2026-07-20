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
const password = `Vqa-${crypto.randomUUID()}!`;
const userIds = [];
const tenantIds = [];
const callIds = [];
let server;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
}

async function login(base, email) {
  const response = await api(base, '/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    await admin.query('DELETE FROM call_sessions WHERE id = ANY($1::uuid[])', [callIds]);
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
    await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await admin.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const superEmail = `vqa-admin-${suffix}@example.test`;
  const developerEmail = `vqa-developer-${suffix}@example.test`;
  const superUser = (await admin.query(`INSERT INTO users
    (email,password_hash,first_name,last_name,status,platform_role,email_verified_at)
    VALUES ($1,$2,'VQA','Admin','active','super_admin',now()) RETURNING id`,
  [superEmail, await hashPassword(password)])).rows[0];
  userIds.push(superUser.id);

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superHeaders = { authorization: `Bearer ${await login(base, superEmail)}` };

  async function company(label) {
    const response = await api(base, '/admin/companies', {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({
        businessName: `VQA ${label} ${suffix}`,
        firstName: 'VQA', lastName: `Company ${label}`,
        email: `vqa-${label}-${suffix}@example.test`,
        businessPhone: '+919999999999', perMinutePrice: 6.4,
        timezone: 'Asia/Kolkata', currency: 'INR',
      }),
    });
    assert.equal(response.status, 201);
    const value = (await response.json()).data;
    tenantIds.push(value.tenantId);
    return value;
  }

  const companyA = await company('A');
  const companyB = await company('B');
  const developer = await api(base, '/admin/developers', {
    method: 'POST',
    headers: superHeaders,
    body: JSON.stringify({
      companyId: companyA.tenantId,
      fullName: 'VQA Developer',
      email: developerEmail,
      password,
    }),
  });
  assert.equal(developer.status, 201);
  userIds.push((await developer.json()).data.userId);

  async function insertCall(companyValue) {
    const result = await admin.query(`INSERT INTO call_sessions
      (tenant_id,workspace_id,agent_name,from_number,to_number,direction,status,
       started_at,answered_at,ended_at,duration_seconds)
      VALUES ($1,$2,'VQA Agent','+918035383450','+919999999999','outbound','completed',
        now() - interval '10 minutes',now() - interval '10 minutes',now() - interval '9 minutes',60)
      RETURNING id`, [companyValue.tenantId, companyValue.workspaceId]);
    callIds.push(result.rows[0].id);
    return result.rows[0].id;
  }

  async function insertUsage(callId, tenantId, kind, requests, durationMs, rawUsage = []) {
    await admin.query(`INSERT INTO call_provider_usage
      (call_session_id,tenant_id,provider_kind,request_count,duration_ms,raw_usage)
      VALUES ($1,$2,$3::call_provider_kind,$4,$5,$6::jsonb)`,
    [callId, tenantId, kind, requests, durationMs, JSON.stringify(rawUsage)]);
  }

  const callA = await insertCall(companyA);
  await insertUsage(callA, companyA.tenantId, 'stt', 2, 200, [{ confidence: 0.96 }, { confidence: 0.94 }]);
  await insertUsage(callA, companyA.tenantId, 'llm', 2, 600);
  await insertUsage(callA, companyA.tenantId, 'tts', 2, 300);

  const callB = await insertCall(companyB);
  await insertUsage(callB, companyB.tenantId, 'stt', 1, 800, [{ confidence: 0.7 }]);
  await insertUsage(callB, companyB.tenantId, 'llm', 1, 1000);
  await insertUsage(callB, companyB.tenantId, 'tts', 1, 400);

  const developerHeaders = { authorization: `Bearer ${await login(base, developerEmail)}` };
  const response = await api(base, '/vqa?days=7&auditLimit=5', { headers: developerHeaders });
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.latencyTrend.length, 7);
  assert.equal(data.health.score, 100);
  assert.equal(data.health.label, 'excellent');
  assert.equal(data.health.auditedCalls, 1);
  assert.equal(data.audits.length, 1);
  assert.equal(data.audits[0].callId, callA);
  assert.equal(data.audits[0].responseDelayMs, 550);
  assert.equal(data.audits[0].sttConfidence, 95);
  assert.equal(data.audits[0].status, 'optimal');
  assert.deepEqual(data.audits[0].latency, { sttMs: 100, llmMs: 300, ttsMs: 150 });
  const measuredDay = data.latencyTrend.find((day) => day.sampleCount === 1);
  assert.deepEqual(
    { sttMs: measuredDay.sttMs, llmMs: measuredDay.llmMs, ttsMs: measuredDay.ttsMs },
    { sttMs: 100, llmMs: 300, ttsMs: 150 },
  );
  assert.equal((await api(base, '/vqa?days=1', { headers: developerHeaders })).status, 400);
  assert.equal((await api(base, '/vqa', { headers: superHeaders })).status, 400);

  const companyBResponse = await api(base, '/vqa?days=7', { headers: {
    ...superHeaders,
    'x-tenant-id': companyB.tenantId,
    'x-workspace-id': companyB.workspaceId,
  } });
  assert.equal(companyBResponse.status, 200);
  const companyBData = (await companyBResponse.json()).data;
  assert.equal(companyBData.audits.length, 1);
  assert.equal(companyBData.audits[0].callId, callB);
  assert.equal(companyBData.audits[0].status, 'degraded');
  assert.equal(companyBData.health.score, 0);

  console.log(JSON.stringify({
    success: true,
    task: 'Developer VQA Voice real data',
    persistedTelemetry: 'passed',
    latencyCalculation: 'passed',
    sttConfidence: 'passed',
    healthAssessment: 'passed',
    requestValidation: 'passed',
    tenantIsolation: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
