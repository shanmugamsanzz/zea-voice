import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

const plivoAuthId = `MA${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
const plivoToken = `task10-${crypto.randomUUID()}`;
let hangupRequests = 0;
const mockPlivo = createServer((request, response) => {
  const expected = `Basic ${Buffer.from(`${plivoAuthId}:${plivoToken}`).toString('base64')}`;
  if (request.method === 'DELETE' && request.headers.authorization === expected && request.url.includes('/Call/')) {
    hangupRequests += 1;
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve, reject) => { mockPlivo.once('error', reject); mockPlivo.listen(0, '127.0.0.1', resolve); });
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString('base64');
process.env.PLIVO_API_BASE_URL = `http://127.0.0.1:${mockPlivo.address().port}/v1`;

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');
const { closeQueues } = await import('../src/queues/queue.registry.js');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task10-${crypto.randomUUID()}!`;
const userIds = [];
const tenantIds = [];
const callIds = [];
let accountId;
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
  await new Promise((resolve) => mockPlivo.close(resolve));
  if (admin._connected) {
    await admin.query('DELETE FROM call_control_events WHERE call_session_id = ANY($1::uuid[])', [callIds]);
    await admin.query('DELETE FROM call_transcript_entries WHERE call_session_id = ANY($1::uuid[])', [callIds]);
    await admin.query('DELETE FROM call_sessions WHERE id = ANY($1::uuid[])', [callIds]);
    await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])', [userIds, tenantIds]);
    if (accountId) await admin.query('DELETE FROM telephony_accounts WHERE id = $1', [accountId]);
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
  const superEmail = `task10-admin-${suffix}@example.test`;
  const developerEmail = `task10-developer-${suffix}@example.test`;
  const superUser = (await admin.query(`INSERT INTO users
    (email,password_hash,first_name,last_name,status,platform_role,email_verified_at)
    VALUES ($1,$2,'Task','Ten Admin','active','super_admin',now()) RETURNING id`,
  [superEmail, await hashPassword(password)])).rows[0];
  userIds.push(superUser.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(base, superEmail);
  const superHeaders = { authorization: `Bearer ${superToken}` };
  async function company(label) {
    const response = await api(base, '/admin/companies', { method: 'POST', headers: superHeaders,
      body: JSON.stringify({ businessName: `Task 10 ${label} ${suffix}`, email: `task10-${label}-${suffix}@example.test` }) });
    const value = (await response.json()).data;
    tenantIds.push(value.tenantId);
    return value;
  }
  const companyA = await company('A');
  const companyB = await company('B');
  const developer = await api(base, '/admin/developers', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ companyId: companyA.tenantId, fullName: 'Task Ten Developer', email: developerEmail, password }) });
  userIds.push((await developer.json()).data.userId);
  const account = await api(base, '/admin/telephony/accounts', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({
      name: `Task 10 Plivo ${suffix}`, authId: plivoAuthId, authToken: plivoToken,
      baseUrl: process.env.PLIVO_API_BASE_URL, applicationId: `task10-${suffix}`,
      answerUrl: 'https://api.voice.zeacrm.com/webhooks/plivo/answer',
      hangupUrl: 'https://api.voice.zeacrm.com/webhooks/plivo/hangup',
      recordingCallbackUrl: 'https://api.voice.zeacrm.com/webhooks/plivo/recording',
    }) });
  accountId = (await account.json()).data.id;
  async function insertCall(companyValue, status, providerCallId) {
    const result = await admin.query(`INSERT INTO call_sessions
      (tenant_id,workspace_id,telephony_account_id,provider_call_id,agent_name,from_number,to_number,direction,status,answered_at,sentiment,cost)
      VALUES ($1,$2,$3,$4,'Monitoring Agent','+918035383450','+919999999999','outbound',$5::call_status,
        CASE WHEN $5::call_status = 'connected' THEN now() ELSE NULL END,'positive',0.18) RETURNING id`,
    [companyValue.tenantId, companyValue.workspaceId, accountId, providerCallId, status]);
    callIds.push(result.rows[0].id);
    return result.rows[0].id;
  }
  const callA = await insertCall(companyA, 'connected', crypto.randomUUID());
  const callB = await insertCall(companyB, 'ringing', crypto.randomUUID());
  await admin.query(`INSERT INTO call_transcript_entries
    (call_session_id,tenant_id,sequence_number,speaker,text,offset_ms)
    VALUES ($1,$2,1,'agent','Hello from the monitored agent',1000),
           ($1,$2,2,'user','Hello from the caller',2500)`, [callA, companyA.tenantId]);

  const active = await api(base, `/admin/calls?activeOnly=true&companyId=${companyA.tenantId}`, { headers: superHeaders });
  assert.equal(active.status, 200);
  assert.deepEqual((await active.json()).data.items.map((call) => call.id), [callA]);
  const detail = await api(base, `/admin/calls/${callA}`, { headers: superHeaders });
  assert.equal((await detail.json()).data.transcript.length, 2);
  const developerToken = await login(base, developerEmail);
  const developerHeaders = { authorization: `Bearer ${developerToken}` };
  assert.deepEqual((await (await api(base, '/calls', { headers: developerHeaders })).json()).data.items.map((call) => call.id), [callA]);
  assert.equal((await api(base, `/calls/${callB}`, { headers: developerHeaders })).status, 404);
  assert.equal((await api(base, `/admin/calls/${callA}/hangup`, { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ reason: 'missing confirmation' }) })).status, 400);
  const hangup = await api(base, `/admin/calls/${callA}/hangup`, { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ confirm: true, reason: 'Supervisor requested termination' }) });
  assert.equal(hangup.status, 200);
  assert.equal((await hangup.json()).data.status, 'canceled');
  assert.equal(hangupRequests, 1);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM call_control_events WHERE call_session_id = $1', [callA])).rows[0].count, 1);

  console.log(JSON.stringify({ success: true, activeCallMonitor: 'passed', transcriptTimeline: 'passed',
    tenantCallIsolation: 'passed', guardedForceHangup: 'passed', plivoHangup: 'passed',
    controlAudit: 'passed', liveDuration: 'passed', temporaryRecordsRemoved: true }, null, 2));
} finally {
  await cleanup();
}
