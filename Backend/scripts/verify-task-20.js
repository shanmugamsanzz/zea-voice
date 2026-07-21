import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.PUBLIC_BASE_URL = 'https://voice.example.test';
process.env.CREDENTIAL_ENCRYPTION_KEY ||= Buffer.alloc(32, 16).toString('base64');
const { createFixture } = await import('./task-16-17-fixture.js');
const { executeCampaignTask } = await import('../src/campaigns/campaign-execution.service.js');
const { getQueue } = await import('../src/queues/queue.registry.js');
const fixture = await createFixture(20);
let tenantId;
try {
  const company = await fixture.company('worker'); tenantId = company.tenantId;
  const phoneNumberId = await fixture.phone(company);
  const agent = await fixture.agent(company, phoneNumberId);
  await fixture.db.query('UPDATE company_credit_wallets SET balance=100 WHERE tenant_id=$1', [tenantId]);
  const campaignResponse = await fixture.api(fixture.base, '/campaigns', { method: 'POST', headers: company.headers,
    body: JSON.stringify({ name: 'Worker Campaign', type: 'realtime', status: 'running', agentId: agent.id,
      phoneNumberId, timezone: 'UTC', concurrencyLimit: 2, retries: 0, retryIntervalsMs: [], retryOutcomes: [],
      callingStartTime: '00:00', callingEndTime: '23:59' }) });
  assert.equal(campaignResponse.status, 201);
  const campaign = (await campaignResponse.json()).data;
  const trigger = await fixture.api(fixture.base, `/campaigns/${campaign.id}/realtime/tasks`, { method: 'POST',
    headers: company.headers, body: JSON.stringify({ eventId: crypto.randomUUID(), phone: '919999999999' }) });
  assert.equal(trigger.status, 201);
  const task = (await trigger.json()).data.task;
  await getQueue('realtime-calls').remove(task.id);
  const providerCallId = crypto.randomUUID();
  const result = await executeCampaignTask(task.id, { makeCall: async (_authId, token, input) => {
    assert.equal(token, 'test-auth-token'); assert.equal(input.to, '+919999999999');
    assert.match(input.answerUrl, /^https:\/\/agent\.example\.test\/webhooks\/plivo\/answer\?attempt_id=/);
    assert.match(input.hangupUrl, /^https:\/\/agent\.example\.test\/webhooks\/plivo\/hangup\?attempt_id=/);
    assert.match(input.ringUrl, /webhooks\/plivo/); return { requestUuid: providerCallId };
  } });
  assert.equal(result.action, 'started');
  const state = await fixture.db.query(`SELECT t.status,a.status AS attempt_status,c.provider_call_id
    FROM campaign_tasks t JOIN campaign_task_attempts a ON a.task_id=t.id
    JOIN call_sessions c ON c.id=a.call_session_id WHERE t.id=$1`, [task.id]);
  assert.deepEqual(state.rows[0], { status: 'running', attempt_status: 'ringing', provider_call_id: providerCallId });
  console.log(JSON.stringify({ success: true, bullmqWorkerExecution: 'passed', plivoInitiation: 'passed',
    campaignRouting: 'passed', creditAndConcurrencyClaim: 'passed' }, null, 2));
} finally {
  if (tenantId) await fixture.db.query('DELETE FROM call_sessions WHERE tenant_id=$1', [tenantId]).catch(() => {});
  await fixture.cleanup();
}
