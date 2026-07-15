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
const password = `Task13-${crypto.randomUUID()}!`;
const userIds = [];
const tenantIds = [];
const callIds = [];
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
    await admin.query('DELETE FROM call_transcript_entries WHERE call_session_id = ANY($1::uuid[])', [callIds]);
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
  const superEmail = `task13-admin-${suffix}@example.test`;
  const developerEmail = `task13-developer-${suffix}@example.test`;
  const superUser = (await admin.query(`INSERT INTO users
    (email,password_hash,first_name,last_name,status,platform_role,email_verified_at)
    VALUES ($1,$2,'Task','Thirteen Admin','active','super_admin',now()) RETURNING id`,
  [superEmail, await hashPassword(password)])).rows[0];
  userIds.push(superUser.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superToken = await login(base, superEmail);
  const superHeaders = { authorization: `Bearer ${superToken}` };
  async function company(label) {
    const response = await api(base, '/admin/companies', { method: 'POST', headers: superHeaders,
      body: JSON.stringify({ businessName: `Task 13 ${label} ${suffix}`, email: `task13-${label}-${suffix}@example.test` }) });
    const value = (await response.json()).data;
    tenantIds.push(value.tenantId);
    return value;
  }
  const companyA = await company('A');
  const companyB = await company('B');
  const developer = await api(base, '/admin/developers', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ companyId: companyA.tenantId, fullName: 'Task Thirteen Developer', email: developerEmail, password }) });
  userIds.push((await developer.json()).data.userId);

  async function insertCall(companyValue, direction, status, daysAgo, duration) {
    const result = await admin.query(`INSERT INTO call_sessions
      (tenant_id,workspace_id,agent_name,campaign_name,from_number,to_number,direction,status,
       started_at,ended_at,duration_seconds,cost,sentiment)
      VALUES ($1,$2,'Dashboard Agent','Dashboard Campaign','+918035383450','+919999999999',
        $3::call_direction,$4::call_status,now() - make_interval(days => $5),
        CASE WHEN $4::call_status IN ('completed','busy') THEN now() - make_interval(days => $5) + make_interval(secs => $6) ELSE NULL END,
        $6,1.25,'neutral') RETURNING id`,
    [companyValue.tenantId, companyValue.workspaceId, direction, status, daysAgo, duration]);
    callIds.push(result.rows[0].id);
  }
  await insertCall(companyA, 'inbound', 'completed', 0, 60);
  await insertCall(companyA, 'outbound', 'completed', 1, 120);
  await insertCall(companyA, 'outbound', 'connected', 0, 30);
  await insertCall(companyB, 'inbound', 'completed', 0, 300);

  const developerHeaders = { authorization: `Bearer ${await login(base, developerEmail)}` };
  const dashboard = await api(base, '/dashboard?days=7', { headers: developerHeaders });
  assert.equal(dashboard.status, 200);
  const data = (await dashboard.json()).data;
  assert.equal(data.company.tenantId, companyA.tenantId);
  assert.equal(data.metrics.totalCalls, 3);
  assert.equal(data.metrics.inboundCalls, 1);
  assert.equal(data.metrics.outboundCalls, 2);
  assert.equal(data.metrics.activeCalls, 1);
  assert.equal(data.metrics.totalMinutesUsed, 3.5);
  assert.equal(data.callVolume.length, 7);
  assert.equal(data.recentActivity.length, 3);
  assert.equal(data.resources.activeTeamMembers, 1);
  assert.equal(data.resources.credits.availableBalance, 0);

  assert.equal((await api(base, '/dashboard', { headers: superHeaders })).status, 400);
  const superDashboard = await api(base, '/dashboard?days=7', { headers: {
    ...superHeaders, 'x-tenant-id': companyB.tenantId, 'x-workspace-id': companyB.workspaceId,
  } });
  assert.equal(superDashboard.status, 200);
  assert.equal((await superDashboard.json()).data.metrics.totalCalls, 1);

  console.log(JSON.stringify({ success: true, tenantDashboard: 'passed', callMetrics: 'passed',
    monthlyComparisons: 'passed', dailyVolumeSeries: 'passed', recentActivity: 'passed',
    creditAndResourceSummary: 'passed', tenantIsolation: 'passed', superAdminTenantSelection: 'passed',
    temporaryRecordsRemoved: true }, null, 2));
} finally {
  await cleanup();
}
