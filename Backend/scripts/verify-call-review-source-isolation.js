import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { getCall } = await import('../src/calls/call.service.js');
const tenantId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const callId = '00000000-0000-4000-8000-000000000003';
const auth = { role: 'COMPANY_DEVELOPER', tenantId, workspaceId, userId: 'user-1' };
let queryNumber = 0;

const call = await getCall(auth, callId, {
  contextRunner: async (operation) => operation({
    async query(sql, values) {
      queryNumber += 1;
      if (queryNumber === 1) {
        assert.deepEqual(values, [callId, tenantId]);
        return { rowCount: 1, rows: [{
          id: callId, tenant_id: tenantId, workspace_id: workspaceId,
          from_number: '+918000000001', to_number: '+919000000001', direction: 'inbound',
          status: 'completed', duration_seconds: 10, live_duration_seconds: 10,
          cost: 0, currency: 'INR', provider_metadata: { voiceRuntime: { ttsLimitUsage: {
            maximumCharactersPerMinute: 900, maximumCallDurationMinutes: 12,
            charactersSynthesized: 321, currentWindowUsed: 81, throttleWaitMs: 0,
            durationLimitReached: false, callDurationSeconds: 10, privateValue: 'must-not-leak',
          } } }, created_at: new Date(), updated_at: new Date(),
        }] };
      }
      assert.match(sql, /call_session_id = \$1 AND tenant_id = \$2/);
      assert.deepEqual(values, [callId, tenantId]);
      return { rowCount: 1, rows: [{
        id: 'entry-1', sequenceNumber: 1, speaker: 'agent', text: 'A safe answer',
        offsetMs: 100, isFinal: true, createdAt: new Date(),
        sources: [
          { type: 'knowledge', id: 'record-1', label: 'catalog', metadata: { documentName: 'company-a.pdf' } },
          { type: 'llm', id: 'model-1', label: 'GPT', metadata: { apiKey: 'must-not-leak', modelKey: 'gpt-test' } },
          { type: 'unsupported_private_source', id: 'private', label: 'private', metadata: {} },
        ],
      }] };
    },
  }),
});

assert.equal(call.companyId, tenantId);
assert.equal(call.transcript.length, 1);
assert.deepEqual(call.transcript[0].sources.map((source) => source.type), ['knowledge', 'llm']);
assert.equal(call.transcript[0].sources[1].metadata.apiKey, undefined);
assert.equal(call.transcript[0].sources[1].metadata.modelKey, 'gpt-test');
assert.deepEqual(call.ttsLimitUsage, {
  maximumCharactersPerMinute: 900,
  maximumCallDurationMinutes: 12,
  charactersSynthesized: 321,
  currentWindowUsed: 81,
  throttleWaitMs: 0,
  characterLimitApplied: false,
  durationLimitReached: false,
  callDurationSeconds: 10,
});
assert.equal(call.ttsLimitUsage.privateValue, undefined);

console.log(JSON.stringify({ success: true, task: 'Tenant-isolated and secret-safe Call Review sources' }));
