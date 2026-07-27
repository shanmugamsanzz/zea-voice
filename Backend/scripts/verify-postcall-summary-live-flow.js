import assert from 'node:assert/strict';
import { completeVoiceCall } from '../src/voice/call-completion.service.js';

function fixture(summaryEnabled, queueImplementation, fetchImplementation) {
  const callId = summaryEnabled ? 'call-summary' : 'call-normal';
  const row = {
    id: callId, tenant_id: 'tenant-1', started_at: new Date(0), answered_at: new Date(1000),
    ended_at: null, duration_seconds: 0, provider_metadata: {},
  };
  const controller = {
    callSession: { id: callId, providerCallId: `provider-${callId}`, direction: 'outbound' },
    terminal: false,
    history: [{ role: 'user', content: 'Call tomorrow.' }],
    async complete() { this.terminal = true; },
    async fail() { this.terminal = true; },
  };
  const runtimeProfile = {
    agent: {
      id: 'agent-1', tenantId: 'tenant-1', workspaceId: 'workspace-1',
      settings: {
        postCallSummaryEnabled: summaryEnabled,
        postCallEndpointDetailsActive: true,
        postCallApiUrl: 'https://hooks.example.test/post-call',
      },
    },
  };
  const contextRunner = async (operation) => operation({
    async query(sql, values) {
      if (sql.startsWith('SELECT * FROM call_sessions')) return { rowCount: 1, rows: [row] };
      if (sql.startsWith('UPDATE call_sessions SET status=')) {
        Object.assign(row, { status: values[1], ended_at: values[2], duration_seconds: values[3] });
        row.provider_metadata = JSON.parse(values[4]);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes("'{voiceRuntime,postCall}'")) return { rowCount: 1, rows: [row] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  return completeVoiceCall({
    controller, runtimeProfile, usageTracker: { report: () => ({ providers: [], totals: {} }) },
    adapters: {}, endedAt: new Date(61000),
  }, {
    contextRunner,
    queuePostCallSummary: queueImplementation,
    fetchImpl: fetchImplementation,
  });
}

let immediateWebhookCalls = 0;
const deferred = await fixture(true, async () => ({
  queued: true, reason: 'created', job: { id: 'summary-job-1' },
}), async () => {
  immediateWebhookCalls += 1;
  return new Response('{}', { status: 200 });
});
assert.equal(deferred.postCall.reason, 'summary_queued');
assert.equal(deferred.postCall.summaryJobId, 'summary-job-1');
assert.equal(immediateWebhookCalls, 0);

let fallbackPayload;
const fallback = await fixture(true, async () => { throw new Error('Redis unavailable with internal details'); },
  async (_url, request) => {
    fallbackPayload = JSON.parse(request.body);
    return new Response('{}', { status: 200 });
  });
assert.equal(fallback.postCall.delivered, true);
assert.equal(fallbackPayload.aiSummary.status, 'queue_failed');
assert.equal(fallbackPayload.aiSummary.error, 'Summary queue unavailable');
assert.doesNotMatch(JSON.stringify(fallbackPayload), /Redis unavailable/);

let normalHeaders;
await fixture(false, undefined, async (_url, request) => {
  normalHeaders = request.headers;
  return new Response('{}', { status: 200 });
});
assert.equal(normalHeaders['idempotency-key'], 'postcall:call-normal');
assert.equal(normalHeaders['x-zea-event-id'], 'call-normal');

console.log(JSON.stringify({
  success: true,
  task: 'Post-Call Summary Task 8 - deferred enriched webhook live flow',
}));
