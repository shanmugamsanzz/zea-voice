import assert from 'node:assert/strict';

process.env.CREDENTIAL_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { CallController } = await import('../src/voice/call-controller.js');
const { ProviderUsageTracker } = await import('../src/voice/provider-usage-tracker.js');
const { completeVoiceCall } = await import('../src/voice/call-completion.service.js');

const runtimeProfile = {
  agent: {
    id: 'agent-1', tenantId: 'tenant-1', workspaceId: 'workspace-1', welcomeMessage: '', settings: {
      postCallEndpointDetailsActive: true,
      postCallApiUrl: 'https://example.test/postcall',
      postCallApiMethod: 'POST',
      postCallApiHeaders: [{ key: 'x-test', value: 'yes' }],
    },
  },
  providers: {
    llm: { providerId: 'llm-provider', providerName: 'Azure', modelId: 'llm-model', modelKey: 'gpt-test' },
    tts: { providerId: 'tts-provider', providerName: 'Any TTS', modelId: 'tts-model', modelKey: 'voice-test' },
  },
};
const callSession = {
  id: 'call-1', providerCallId: 'provider-call-1', direction: 'inbound',
};
const controller = new CallController({ callSession, runtimeProfile, now: 1000 });
await controller.initialize(1000);
await controller.receiveFinalTranscript('Hello', 2000);
await controller.setAssistantResponse('Hi there', 3000);
await controller.playbackComplete(4000);

const usageTracker = new ProviderUsageTracker(runtimeProfile);
usageTracker.record('llm', { inputTokens: 10, outputTokens: 5, durationMs: 40, cost: 0.002 });
usageTracker.record('llm', { inputTokens: 4, outputTokens: 3, durationMs: 20, cost: 0.001 });
usageTracker.record('tts', { characters: 8, audioOutputMs: 1200, cost: 0.004 });

const rows = [{
  id: 'call-1', tenant_id: 'tenant-1', started_at: new Date(0), answered_at: new Date(1000),
  ended_at: null, duration_seconds: 0, provider_metadata: {},
}];
const persistedUsage = [];
let persistedPostCall;
const contextRunner = async (operation) => operation({
  async query(sql, values) {
    if (sql.startsWith('SELECT * FROM call_sessions')) return { rowCount: 1, rows };
    if (sql.includes('INSERT INTO call_provider_usage')) { persistedUsage.push(values); return { rowCount: 1, rows: [] }; }
    if (sql.includes("'{voiceRuntime,postCall}'")) {
      persistedPostCall = JSON.parse(values[1]);
      rows[0].provider_metadata.voiceRuntime.postCall = persistedPostCall;
      return { rowCount: 1, rows };
    }
    if (sql.startsWith('UPDATE call_sessions')) {
      rows[0] = { ...rows[0], status: values[1], ended_at: values[2], duration_seconds: values[3],
        provider_metadata: { ...rows[0].provider_metadata, ...JSON.parse(values[4]) } };
      return { rowCount: 1, rows };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  },
});
let webhookPayload;
const fetchImpl = async (_url, request) => {
  webhookPayload = JSON.parse(request.body);
  return new Response(JSON.stringify({ accepted: true }), { status: 200 });
};
let sttClosed = false;
const result = await completeVoiceCall({
  controller, runtimeProfile, usageTracker, adapters: {
    stt: { async close() { sttClosed = true; } },
    llm: {},
    tts: { async close() { throw new Error('socket already closed'); } },
  },
  endedAt: new Date(61000),
  metrics: { knowledge: [{ route: 'faq', found: true, durationMs: 8 }] },
}, { contextRunner, fetchImpl });

assert.equal(result.call.status, 'completed');
assert.equal(result.call.duration_seconds, 60);
assert.equal(result.usage.totals.inputTokens, 14);
assert.equal(result.usage.totals.outputTokens, 8);
assert.equal(result.usage.totals.totalTokens, 22);
assert.equal(result.usage.totals.cost, 0.007);
assert.equal(result.usage.providers.length, 2);
assert.equal(persistedUsage.length, 2);
assert.equal(result.postCall.delivered, true);
assert.equal(persistedPostCall.delivered, true);
assert.equal(rows[0].provider_metadata.voiceRuntime.metrics.knowledge[0].durationMs, 8);
assert.equal(webhookPayload.call.status, 'completed');
assert.equal(webhookPayload.providerUsage.totals.characters, 8);
assert.equal(sttClosed, true);
assert.equal(result.adapterCleanup.find((item) => item.kind === 'tts').closed, false);
assert.equal(controller.terminal, true);

console.log(JSON.stringify({ success: true, task: 'Voice Task 10 - complete call and report provider usage' }));
