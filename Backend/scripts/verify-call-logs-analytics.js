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

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = 'CallLogs-' + crypto.randomUUID() + '!';
const userIds = [];
const tenantIds = [];
const callIds = [];
let server;

async function api(base, path, options = {}) {
  return fetch(base + path, {
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
  const frontendSource = await readFile(
    new URL('../../Frontend/src/components/views/CallLogsAnalyticsView.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(frontendSource, /Math\.random|call-log-|COMPLETED_CALL_LOGS|Shanmuga_test/);
  assert.match(frontendSource, /\/calls\?/);
  assert.match(frontendSource, /\/calls\//);

  await admin.connect();
  const superEmail = 'call-logs-admin-' + suffix + '@example.test';
  const developerEmail = 'call-logs-developer-' + suffix + '@example.test';
  const superUser = (await admin.query(
    "INSERT INTO users (email,password_hash,first_name,last_name,status,platform_role,email_verified_at) VALUES ($1,$2,'Call Logs','Admin','active','super_admin',now()) RETURNING id",
    [superEmail, await hashPassword(password)],
  )).rows[0];
  userIds.push(superUser.id);

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const superHeaders = { authorization: 'Bearer ' + await login(base, superEmail) };

  async function company(label) {
    const response = await api(base, '/admin/companies', {
      method: 'POST',
      headers: superHeaders,
      body: JSON.stringify({
        businessName: 'Call Logs ' + label + ' ' + suffix,
        firstName: 'Call', lastName: 'Logs ' + label,
        email: 'call-logs-' + label + '-' + suffix + '@example.test',
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
      fullName: 'Call Logs Developer',
      email: developerEmail,
      password,
    }),
  });
  assert.equal(developer.status, 201);
  userIds.push((await developer.json()).data.userId);

  async function insertCall(companyValue, direction, status, daysAgo, agentName) {
    const result = await admin.query(
      "INSERT INTO call_sessions (tenant_id,workspace_id,agent_name,campaign_name,from_number,to_number,direction,status,sentiment,started_at,ended_at,duration_seconds,cost,currency) VALUES ($1,$2,$3,'Database Campaign','+918035383450','+919999999999',$4::call_direction,$5::call_status,'neutral',now() - make_interval(days => $6),CASE WHEN $5::call_status IN ('completed','busy') THEN now() - make_interval(days => $6) + interval '1 minute' ELSE NULL END,CASE WHEN $5::call_status = 'completed' THEN 60 ELSE 0 END,0.25,'INR') RETURNING id",
      [companyValue.tenantId, companyValue.workspaceId, agentName, direction, status, daysAgo],
    );
    callIds.push(result.rows[0].id);
    return result.rows[0].id;
  }

  const recentA = await insertCall(companyA, 'inbound', 'completed', 0, 'Tenant A Recent');
  await insertCall(companyA, 'outbound', 'busy', 2, 'Tenant A Busy');
  await insertCall(companyA, 'outbound', 'completed', 10, 'Tenant A Old');
  const recentB = await insertCall(companyB, 'inbound', 'completed', 0, 'Tenant B Private');
  await admin.query(
    "INSERT INTO call_transcript_entries (call_session_id,tenant_id,sequence_number,speaker,text,offset_ms) VALUES ($1,$2,1,'agent','Stored agent transcript',1000),($1,$2,2,'user','Stored customer transcript',2500)",
    [recentA, companyA.tenantId],
  );

  const developerHeaders = { authorization: 'Bearer ' + await login(base, developerEmail) };
  const startedFrom = encodeURIComponent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  const firstPage = await api(base, '/calls?page=1&pageSize=1&startedFrom=' + startedFrom, {
    headers: developerHeaders,
  });
  assert.equal(firstPage.status, 200);
  const firstData = (await firstPage.json()).data;
  assert.equal(firstData.items.length, 1);
  assert.equal(firstData.pagination.total, 2);
  assert.equal(firstData.pagination.totalPages, 2);
  assert.equal(firstData.summary.total, 2);
  assert.equal(firstData.summary.inbound, 1);
  assert.equal(firstData.summary.outbound, 1);
  assert.equal(firstData.items[0].id, recentA);
  assert.notEqual(firstData.items[0].id, recentB);

  const secondPage = await api(base, '/calls?page=2&pageSize=1&startedFrom=' + startedFrom, {
    headers: developerHeaders,
  });
  assert.equal(secondPage.status, 200);
  assert.equal((await secondPage.json()).data.items.length, 1);

  const allTime = await api(base, '/calls?page=1&pageSize=100', { headers: developerHeaders });
  assert.equal(allTime.status, 200);
  assert.equal((await allTime.json()).data.pagination.total, 3);

  const detail = await api(base, '/calls/' + recentA, { headers: developerHeaders });
  assert.equal(detail.status, 200);
  const detailData = (await detail.json()).data;
  assert.equal(detailData.id, recentA);
  assert.equal(detailData.transcript.length, 2);
  assert.equal(detailData.transcript[0].text, 'Stored agent transcript');
  assert.equal((await api(base, '/calls/' + recentB, { headers: developerHeaders })).status, 404);

  console.log(JSON.stringify({
    success: true,
    task: 'Developer Call Logs Analytics real data',
    mockRemoval: 'passed',
    databasePagination: 'passed',
    dateFiltering: 'passed',
    summaryCounts: 'passed',
    storedTranscript: 'passed',
    tenantIsolation: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
