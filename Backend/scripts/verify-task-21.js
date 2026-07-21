import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.PUBLIC_BASE_URL = 'https://voice.example.test';
process.env.CREDENTIAL_ENCRYPTION_KEY ||= Buffer.alloc(32, 16).toString('base64');
const { createFixture } = await import('./task-16-17-fixture.js');
const { executeCampaignTask } = await import('../src/campaigns/campaign-execution.service.js');
const { processPlivoCallback, validatePlivoSignature } = await import('../src/telephony/plivo-webhook.service.js');
const { getQueue } = await import('../src/queues/queue.registry.js');
const fixture = await createFixture(21);
const sign = (url, nonce, payload) => crypto.createHmac('sha256', 'test-auth-token').update(`${url}?`
  + Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}${v}`).join('') + `.${nonce}`).digest('base64');
let tenantId;
try {
  const company = await fixture.company('callbacks'); tenantId = company.tenantId;
  const phoneNumberId = await fixture.phone(company); const agent = await fixture.agent(company, phoneNumberId);
  await fixture.db.query('UPDATE company_credit_wallets SET balance=100 WHERE tenant_id=$1', [tenantId]);
  const created = await fixture.api(fixture.base, '/campaigns', { method: 'POST', headers: company.headers,
    body: JSON.stringify({ name: 'Retry Campaign', type: 'realtime', status: 'running', agentId: agent.id,
      phoneNumberId, timezone: 'UTC', concurrencyLimit: 2, retries: 1, retryIntervalsMs: [1000],
      retryOutcomes: ['busy'], callingStartTime: '00:00', callingEndTime: '23:59' }) });
  const campaign = (await created.json()).data;
  const triggered = await fixture.api(fixture.base, `/campaigns/${campaign.id}/realtime/tasks`, { method: 'POST',
    headers: company.headers, body: JSON.stringify({ eventId: crypto.randomUUID(), phone: '918888888888' }) });
  const task = (await triggered.json()).data.task; await getQueue('realtime-calls').remove(task.id);
  const firstProviderId = crypto.randomUUID();
  const first = await executeCampaignTask(task.id, { makeCall: async () => ({ requestUuid: firstProviderId }) });
  const firstPayload = { CallUUID: firstProviderId, CallStatus: 'busy', HangupCauseName: 'User Busy', Duration: '0' };
  const firstUrl = `${process.env.PUBLIC_BASE_URL}/webhooks/plivo/calls/${first.attemptId}/hangup`; const nonce = 'nonce-one';
  assert.equal(validatePlivoSignature(firstUrl, nonce, sign(firstUrl, nonce, firstPayload), 'test-auth-token', firstPayload), true);
  const callback = await processPlivoCallback({ attemptId: first.attemptId, eventType: 'hangup', payload: firstPayload,
    nonce, signature: sign(firstUrl, nonce, firstPayload) });
  assert.equal(callback.result.action, 'retry');
  assert.equal((await processPlivoCallback({ attemptId: first.attemptId, eventType: 'hangup', payload: firstPayload,
    nonce, signature: sign(firstUrl, nonce, firstPayload) })).duplicate, true);
  await getQueue('call-retries').remove(`${task.id}:retry:1`);
  const secondProviderId = crypto.randomUUID();
  const second = await executeCampaignTask(task.id, { makeCall: async () => ({ requestUuid: secondProviderId }) });
  const secondPayload = { CallUUID: secondProviderId, CallStatus: 'busy', HangupCauseName: 'User Busy', Duration: '0' };
  const secondUrl = `${process.env.PUBLIC_BASE_URL}/webhooks/plivo/calls/${second.attemptId}/hangup`; const nonceTwo = 'nonce-two';
  const final = await processPlivoCallback({ attemptId: second.attemptId, eventType: 'hangup', payload: secondPayload,
    nonce: nonceTwo, signature: sign(secondUrl, nonceTwo, secondPayload) });
  assert.equal(final.result.action, 'final'); assert.equal(final.status, 'busy');
  const state = await fixture.db.query(`SELECT t.status,t.retry_count,t.final_outcome,c.completed_tasks,
    (SELECT count(*)::int FROM campaign_task_attempts WHERE task_id=t.id) AS attempts
    FROM campaign_tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE t.id=$1`, [task.id]);
  assert.deepEqual(state.rows[0], { status: 'busy', retry_count: 1, final_outcome: 'busy', completed_tasks: 1, attempts: 2 });
  console.log(JSON.stringify({ success: true, signatureV3Validation: 'passed', callbackIdempotency: 'passed',
    configuredOutcomeRetry: 'passed', retryCountPersistence: 'passed', finalBusyOutcome: 'passed' }, null, 2));
} finally {
  if (tenantId) await fixture.db.query('DELETE FROM call_sessions WHERE tenant_id=$1', [tenantId]).catch(() => {});
  await fixture.cleanup();
}
