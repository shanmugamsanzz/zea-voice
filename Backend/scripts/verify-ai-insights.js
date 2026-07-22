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
const password = 'AiInsights-' + crypto.randomUUID() + '!';
const userIds = [];
const tenantIds = [];
const callIds = [];
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
  if (admin._connected) {
    await admin.query(
      'DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])',
      [userIds, tenantIds],
    );
    await admin.query('DELETE FROM call_sessions WHERE id = ANY($1::uuid[])', [callIds]);
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
  const frontend = await readFile(
    new URL('../../Frontend/src/components/views/AiInsightsView.tsx', import.meta.url),
    'utf8',
  );
  const companyViews = await readFile(
    new URL('../../Frontend/src/components/views/CompanyViews.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(frontend + companyViews, /Pricing & Subscription Plans|Autonomous Recommendations Captured|Math\.random/);
  assert.match(frontend, /\/ai-insights\?/);
  assert.match(frontend, /\/ai-insights\/reviews\//);

  await admin.connect();
  const superEmail = 'ai-insights-admin-' + suffix + '@example.test';
  const developerEmail = 'ai-insights-developer-' + suffix + '@example.test';
  const companyUserEmail = 'ai-insights-user-' + suffix + '@example.test';
  const superUser = (await admin.query(
    "INSERT INTO users (email,password_hash,first_name,last_name,status,platform_role,email_verified_at) "
      + "VALUES ($1,$2,'AI Insights','Admin','active','super_admin',now()) RETURNING id",
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
        businessName: 'AI Insights ' + label + ' ' + suffix,
        firstName: 'AI', lastName: 'Insights ' + label,
        email: 'ai-insights-' + label + '-' + suffix + '@example.test',
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
      headers: superHeaders,
      body: JSON.stringify({ companyId, fullName, email, password, role }),
    });
    assert.equal(response.status, 201);
    const value = (await response.json()).data;
    userIds.push(value.userId);
    return value;
  }

  const companyA = await company('A');
  const companyB = await company('B');
  await member(companyA.tenantId, 'AI Insights Developer', developerEmail, 'COMPANY_DEVELOPER');
  await member(companyA.tenantId, 'AI Insights User', companyUserEmail, 'COMPANY_USER');
  const agentOne = crypto.randomUUID();
  const agentTwo = crypto.randomUUID();
  const campaignOne = crypto.randomUUID();

  async function insertCall(companyValue, input) {
    const result = await admin.query(
      "INSERT INTO call_sessions "
      + "(tenant_id,workspace_id,agent_id,agent_name,campaign_id,campaign_name,from_number,to_number,direction,status,sentiment,started_at,ended_at,duration_seconds) "
      + "VALUES ($1,$2,$3,$4,$5,$6,'+918035383450','+919999999999',$7::call_direction,$8::call_status,$9::call_sentiment,"
      + "now() - make_interval(hours => $10),CASE WHEN $8::call_status IN ('completed','failed') THEN now() - make_interval(hours => $10) + interval '1 minute' ELSE NULL END,$11) RETURNING id",
      [
        companyValue.tenantId,
        companyValue.workspaceId,
        input.agentId,
        input.agentName,
        input.campaignId,
        input.campaignName,
        input.direction,
        input.status,
        input.sentiment,
        input.hoursAgo,
        input.duration,
      ],
    );
    callIds.push(result.rows[0].id);
    return result.rows[0].id;
  }

  const callbackCall = await insertCall(companyA, {
    agentId: agentOne, agentName: 'Sales Agent', campaignId: campaignOne,
    campaignName: 'Renewal Campaign', direction: 'outbound', status: 'completed',
    sentiment: 'positive', hoursAgo: 1, duration: 60,
  });
  const transferCall = await insertCall(companyA, {
    agentId: agentTwo, agentName: 'Support Agent', campaignId: campaignOne,
    campaignName: 'Renewal Campaign', direction: 'inbound', status: 'failed',
    sentiment: 'negative', hoursAgo: 2, duration: 30,
  });
  await insertCall(companyA, {
    agentId: agentOne, agentName: 'Sales Agent', campaignId: null,
    campaignName: null, direction: 'inbound', status: 'completed',
    sentiment: 'neutral', hoursAgo: 3, duration: 45,
  });
  const privateCall = await insertCall(companyB, {
    agentId: crypto.randomUUID(), agentName: 'Private Agent', campaignId: null,
    campaignName: null, direction: 'inbound', status: 'completed',
    sentiment: 'positive', hoursAgo: 1, duration: 50,
  });

  await admin.query(
    "INSERT INTO call_transcript_entries "
    + "(call_session_id,tenant_id,sequence_number,speaker,text,offset_ms,is_final) VALUES "
    + "($1,$2,1,'agent','How can I help?',100,true),"
    + "($1,$2,2,'user','Please call me back tomorrow.',500,true)",
    [callbackCall, companyA.tenantId],
  );
  await admin.query(
    "INSERT INTO call_transcript_entries "
    + "(call_session_id,tenant_id,sequence_number,speaker,text,offset_ms,is_final) VALUES "
    + "($1,$2,1,'user','Transfer me to a human agent.',300,false)",
    [transferCall, companyA.tenantId],
  );
  await admin.query(
    "INSERT INTO call_provider_usage "
    + "(call_session_id,tenant_id,provider_kind,provider_name,model_key,request_count,duration_ms) "
    + "VALUES ($1,$2,'stt','Fixture Provider','fixture-stt',2,1000),"
    + "($1,$2,'llm','Fixture Provider','fixture-llm',2,4000)",
    [callbackCall, companyA.tenantId],
  );
  await admin.query(
    "INSERT INTO call_provider_usage "
    + "(call_session_id,tenant_id,provider_kind,provider_name,model_key,request_count,duration_ms) "
    + "VALUES ($1,$2,'stt','Private Provider','private-stt',1,100)",
    [privateCall, companyB.tenantId],
  );

  const developerHeaders = { authorization: 'Bearer ' + await login(base, developerEmail) };
  const developerResponse = await api(base, '/ai-insights?days=30&queueLimit=10', {
    headers: developerHeaders,
  });
  assert.equal(developerResponse.status, 200);
  const developerData = (await developerResponse.json()).data;
  assert.equal(developerData.access.mode, 'developer');
  assert.equal(developerData.access.canExport, true);
  assert.equal(developerData.access.canReview, true);
  assert.equal(developerData.summary.totalCalls, 3);
  assert.equal(developerData.summary.completedCalls, 2);
  assert.equal(developerData.summary.failedCalls, 1);
  assert.equal(developerData.callbackQueue[0].callId, callbackCall);
  assert.equal(developerData.transferQueue[0].callId, transferCall);
  assert.equal(developerData.providerImpact.length, 2);
  assert.ok(developerData.providerImpact.every((row) => row.providerName === 'Fixture Provider'));
  assert.ok(developerData.recommendations.length > 0);
  assert.equal(developerData.filterOptions.agents.length, 2);
  assert.equal(developerData.filterOptions.campaigns.length, 1);
  assert.ok(!JSON.stringify(developerData).includes(privateCall));
  assert.ok(!JSON.stringify(developerData).includes('Private Provider'));

  const filteredResponse = await api(
    base,
    '/ai-insights?days=30&agentId=' + agentTwo,
    { headers: developerHeaders },
  );
  assert.equal(filteredResponse.status, 200);
  assert.equal((await filteredResponse.json()).data.summary.totalCalls, 1);

  const reviewResponse = await api(base, '/ai-insights/reviews/' + transferCall, {
    method: 'POST',
    headers: developerHeaders,
    body: JSON.stringify({ note: 'Reviewed by verification' }),
  });
  assert.equal(reviewResponse.status, 201);
  const afterReview = await api(base, '/ai-insights?days=30', { headers: developerHeaders });
  const afterReviewData = (await afterReview.json()).data;
  assert.ok(afterReviewData.recentReviewed.some((call) => call.callId === transferCall));
  assert.ok(!afterReviewData.reviewQueue.some((call) => call.callId === transferCall));

  const userHeaders = { authorization: 'Bearer ' + await login(base, companyUserEmail) };
  const userResponse = await api(base, '/ai-insights?days=30', { headers: userHeaders });
  assert.equal(userResponse.status, 200);
  const userData = (await userResponse.json()).data;
  assert.equal(userData.access.mode, 'user');
  assert.equal(userData.access.readOnly, true);
  assert.equal(userData.access.canExport, false);
  assert.equal(userData.access.canReview, false);
  assert.equal(userData.access.providerImpactVisible, false);
  assert.equal(userData.summary.totalCalls, 3);
  assert.deepEqual(userData.providerImpact, []);
  assert.deepEqual(userData.recommendations, []);
  assert.equal(
    (await api(base, '/ai-insights/reviews/' + callbackCall, {
      method: 'POST',
      headers: userHeaders,
      body: '{}',
    })).status,
    403,
  );
  assert.equal((await api(base, '/ai-insights?days=1', { headers: developerHeaders })).status, 400);

  console.log(JSON.stringify({
    success: true,
    task: 'Developer and User AI Insights real data',
    mockRemoval: 'passed',
    realDatabaseAnalytics: 'passed',
    developerFeatures: 'passed',
    userReadOnlyAccess: 'passed',
    providerPrivacy: 'passed',
    filters: 'passed',
    reviewAuditHistory: 'passed',
    tenantIsolation: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
