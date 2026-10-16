import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertSingleLlmTurnArchitecture,
  createSingleLlmTurnInvoker,
  runTemplateEngineProductionTurn,
} from '../src/voice/interaction/template-engine-production-runtime.js';
import { templateEngineMessageSources } from '../src/voice/source-trace.js';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import {
  createQdrantRetrievalRequest, QDRANT_RETRIEVAL_LIMITS,
} from '../src/voice/interaction/qdrant-retrieval-contract.js';

assert.equal(typeof runTemplateEngineProductionTurn, 'function');

let providerCalls = 0;
const guarded = createSingleLlmTurnInvoker(async () => {
  providerCalls += 1;
  return { outputParsed: { decision: 'RESPONSE' } };
});
const request = Object.freeze({ responseFormat: Object.freeze({
  type: 'json_schema', name: 'agent_qdrant_universal_turn',
}) });
await guarded.invoke(request);
await assert.rejects(() => guarded.invoke(request), {
  code: 'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED',
});
assert.equal(providerCalls, 1);
assert.equal(guarded.count(), 1);

assert.equal(assertSingleLlmTurnArchitecture({
  invocationCount: 1, requireExactlyOne: true, turnKind: 'factual',
}).maximumInvocations, 1);
assert.throws(() => assertSingleLlmTurnArchitecture({ invocationCount: 2 }), {
  code: 'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED',
});
assert.equal(assertSingleLlmTurnArchitecture({
  invocationCount: 2, requiredInvocations: 2, maximumInvocations: 2, turnKind: 'tool_result',
}).requiredInvocations, 2);

await assert.rejects(() => runTemplateEngineProductionTurn({
  auth: { tenantId: 'tenant-a' },
  scope: { tenantId: 'tenant-b', agentId: 'agent-a' },
  latestUtterance: 'Question',
  cancellationSignal: new AbortController().signal,
}, {
  invokeStructuredLlm: async () => ({}),
  retrieveQdrantKnowledge: async () => {
    throw new Error('Retrieval must not run across tenant boundaries');
  },
  runQdrantUniversalTurn: async () => ({}),
}), { code: 'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_MISMATCH' });

let retrievalCancelled = false;
const cancellation = new AbortController();
const cancelledTurn = runTemplateEngineProductionTurn({
  auth: { tenantId: 'tenant-a' },
  scope: { tenantId: 'tenant-a', agentId: 'agent-a' },
  latestUtterance: 'Question',
  cancellationSignal: cancellation.signal,
}, {
  invokeStructuredLlm: async () => ({}),
  retrieveQdrantKnowledge: ({ cancellationSignal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 500);
    cancellationSignal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      retrievalCancelled = true;
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  }),
  runQdrantUniversalTurn: async () => ({}),
});
setTimeout(() => cancellation.abort('test_cancelled'), 10);
await assert.rejects(cancelledTurn, { name: 'AbortError' });
assert.equal(retrievalCancelled, true);

// Exercise the actual universal turn and production result boundary. Direct
// source-helper tests alone cannot catch Live Data dropped between these layers.
const liveTables = [{ id: 'table-properties', name: 'Current Properties', rowCount: 1,
  truncated: false, columns: [{ name: 'Rate', key: 'rate', type: 'number' }],
  rows: [{ id: 'plot-1', values: { rate: 1950, privateNote: 'not-source-metadata' } }] }];
const knowledgeChunks = [{ id: 'knowledge-1', text: 'Property viewing information.',
  source: { documentId: 'document-1', filename: 'viewing.txt', chunkIndex: 0 }, score: 0.9 }];
for (const scenario of [
  { name: 'live-data-only', liveData: liveTables, chunks: [], types: ['llm', 'live_data'] },
  { name: 'mixed', liveData: liveTables, chunks: knowledgeChunks,
    types: ['llm', 'knowledge', 'live_data'] },
  { name: 'knowledge-only', chunks: knowledgeChunks, types: ['llm', 'knowledge'] },
  { name: 'empty', liveData: [], chunks: [], types: ['llm'] },
]) {
  let calls = 0;
  const signal = new AbortController().signal;
  const retrievalRequest = createQdrantRetrievalRequest({ tenantId: 'tenant-a',
    agentId: 'agent-a', question: 'Property rate?', cancellationSignal: signal });
  const turn = await runTemplateEngineProductionTurn({
    auth: { tenantId: 'tenant-a' }, scope: { tenantId: 'tenant-a', agentId: 'agent-a' },
    latestUtterance: 'Property rate?', mainPrompt: 'Use current supplied facts.',
    cancellationSignal: signal,
  }, {
    runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
    retrieveQdrantKnowledge: async () => ({ request: retrievalRequest,
      chunks: scenario.chunks, liveData: scenario.liveData,
      diagnostics: { queryEmbeddingCount: 1, qdrantSearchCount: 1,
        returnedChunkCount: scenario.chunks.length,
        maximumChunks: QDRANT_RETRIEVAL_LIMITS.maximumChunks, tenantAgentFiltered: true } }),
    invokeStructuredLlm: async (input) => {
      calls += 1;
      if (scenario.liveData?.length) {
        assert.ok(input.messages[0].content.includes(JSON.stringify(liveTables)));
      }
      return { outputParsed: { outcome: 'FACTUAL_ANSWER',
        speech: 'Here are the supplied property details.', workflowAction: null } };
    },
  });
  assert.equal(calls, 1, scenario.name);
  assert.equal(turn.speech, 'Here are the supplied property details.');
  assert.strictEqual(turn.liveData, scenario.liveData);
  const sources = templateEngineMessageSources(turn, { turnId: scenario.name });
  assert.deepEqual(sources.map((entry) => entry.type), scenario.types, scenario.name);
  const liveSource = sources.find((entry) => entry.type === 'live_data');
  if (scenario.liveData?.length) {
    assert.equal(liveSource.metadata.tableId, liveTables[0].id);
    assert.equal(liveSource.metadata.tableName, liveTables[0].name);
    assert.equal(liveSource.metadata.rowCount, 1);
    assert.equal(liveSource.metadata.truncated, false);
    assert.equal(liveSource.metadata.rows, undefined);
    assert.equal(liveSource.metadata.columns, undefined);
    assert.ok(!JSON.stringify(sources).includes('not-source-metadata'));
  } else assert.equal(liveSource, undefined);
}

const source = await readFile(new URL(
  '../src/voice/interaction/template-engine-production-runtime.js', import.meta.url,
), 'utf8');
const orchestratorSource = await readFile(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');
assert.match(source, /retrieveAgentQdrantKnowledge/u);
assert.match(source, /runAgentQdrantUniversalTurn/u);
assert.doesNotMatch(source, /retrieveEvidence|loadPublishedContext|postSearchDecision/u);
assert.doesNotMatch(source, /deterministic(?:Acknowledgement|Identity|Conversation|Workflow|Welcome)/u);
assert.doesNotMatch(source, /acknowledgementPhrases|explicitStopPhrases/u);
assert.doesNotMatch(source, /turnDeadlineAt|UNIVERSAL_TURN_LATENCY_BUDGET/u);
assert.doesNotMatch(orchestratorSource,
  /classifyFinalCallCheckUtterance|resolveCustomerCallbackRequest|classifyFinalCallEndUtterance/u);

console.log(JSON.stringify({
  suite: 'template-engine-production-runtime',
  passed: true,
  retrieval: 'qdrant',
  normalMaximumLlmCallsPerTurn: 1,
  toolResultLlmCallsPerTurn: 2,
  languageOrBusinessRouting: false,
  legacyRetrievalBranches: 0,
}));
