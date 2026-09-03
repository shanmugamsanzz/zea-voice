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

const contextRunner = async (operation) => operation({
    async query(sql, values) {
      queryNumber += 1;
      if (queryNumber === 1) {
        assert.deepEqual(values, [callId, tenantId]);
        return { rowCount: 1, rows: [{
          id: callId, tenant_id: tenantId, workspace_id: workspaceId,
          from_number: '+918000000001', to_number: '+919000000001', direction: 'inbound',
          status: 'completed', duration_seconds: 10, live_duration_seconds: 10,
          cost: 0, currency: 'INR', provider_metadata: { voiceRuntime: {
            metrics: {
              turnLatency: [{ epoch: 1, retrievalMs: 25, totalFirstAudioMs: 400 }],
              tools: [], providerFailures: { total: 0 },
            },
            ttsLimitUsage: {
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
          { type: 'knowledge', id: 'evidence-1', label: 'Catalog', metadata: {
            recordId: 'record-1', documentId: 'document-1', documentName: 'company-a.pdf',
            documentDisplayName: 'Company A Catalog', sourceSection: 'Option Alpha', pageNumber: 2,
          } },
          { type: 'llm', id: 'turn-1', label: 'Template engine decision', metadata: {
            apiKey: 'must-not-leak', engine: 'template_engine_v1',
            modelKey: 'gpt-test',
            initialDecision: 'SEARCH', finalDecision: 'RESPONSE', evidenceIds: ['evidence-1'],
            validationResult: 'valid',
          } },
          { type: 'unsupported_private_source', id: 'private', label: 'private', metadata: {} },
        ],
      }] };
    },
  });

const call = await getCall(auth, callId, { contextRunner });

assert.equal(call.companyId, tenantId);
assert.equal(call.transcript.length, 1);
assert.deepEqual(call.transcript[0].sources.map((source) => source.type), ['knowledge', 'llm']);
assert.equal(call.transcript[0].sources[1].metadata.apiKey, undefined);
assert.equal(call.transcript[0].sources[1].metadata.modelKey, 'gpt-test');
assert.equal(call.transcript[0].sources[1].metadata.initialDecision, 'SEARCH');
assert.deepEqual(call.transcript[0].sources[1].metadata.evidenceIds, ['evidence-1']);
assert.equal(call.transcript[0].sources[1].metadata.validationResult, 'valid');
assert.equal(call.transcript[0].sources[0].metadata.documentDisplayName, 'Company A Catalog');
assert.equal(call.transcript[0].sources[0].metadata.sourceSection, 'Option Alpha');
assert.equal(call.transcript[0].sources[0].metadata.pageNumber, 2);
assert.equal(call.runtimeObservability.turnLatency.length, 1);
assert.equal(call.runtimeObservability.turnLatency[0].retrievalMs, 25);
assert.deepEqual(call.ttsLimitUsage, {
  maximumCharactersPerResponse: 0,
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

queryNumber = 0;
const userCall = await getCall({
  role: 'COMPANY_USER', tenantId, workspaceId, userId: 'user-2',
}, callId, { contextRunner });
assert.deepEqual(userCall.transcript[0].sources, []);
assert.equal(userCall.runtimeObservability, null);

console.log(JSON.stringify({ success: true, task: 'Tenant-isolated and secret-safe Call Review sources' }));
