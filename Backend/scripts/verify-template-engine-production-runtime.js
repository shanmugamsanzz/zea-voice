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
await assert.rejects(() => runTemplateEngineProductionTurn({
  auth: { tenantId: 'tenant-a' },
  scope: { tenantId: 'tenant-a', agentId: 'agent-a' },
  latestUtterance: 'Question',
  cancellationSignal: new AbortController().signal,
  turnDeadlineAt: Date.now() + 3_000,
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
}), { code: 'VOICE_RETRIEVAL_DEADLINE' });
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
assert.doesNotMatch(orchestratorSource,
  /classifyFinalCallCheckUtterance|resolveCustomerCallbackRequest|classifyFinalCallEndUtterance/u);

console.log(JSON.stringify({
  suite: 'template-engine-production-runtime',
  passed: true,
  retrieval: 'qdrant',
  maximumLlmCallsPerTurn: 1,
  languageOrBusinessRouting: false,
  legacyRetrievalBranches: 0,
}));
