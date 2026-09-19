import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertSingleLlmTurnArchitecture,
  createSingleLlmTurnInvoker,
  runTemplateEngineProductionTurn,
} from '../src/voice/interaction/template-engine-production-runtime.js';

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
