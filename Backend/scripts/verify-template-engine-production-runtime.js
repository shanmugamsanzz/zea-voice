import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertSingleLlmTurnArchitecture,
  createSingleLlmTurnInvoker,
  deterministicAcknowledgementDecision,
  runTemplateEngineProductionTurn,
} from '../src/voice/interaction/template-engine-production-runtime.js';

assert.equal(typeof runTemplateEngineProductionTurn, 'function');

let providerCalls = 0;
const guarded = createSingleLlmTurnInvoker(async () => {
  providerCalls += 1;
  return { outputParsed: { decision: 'RESPONSE' } };
});
const request = Object.freeze({ responseFormat: Object.freeze({
  type: 'json_schema', name: 'agent_qdrant_grounded_answer',
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

const acknowledgement = deterministicAcknowledgementDecision({
  utterance: 'okay', acknowledgementPhrases: ['okay'],
});
assert.equal(acknowledgement.decision, 'RESPONSE');

const source = await readFile(new URL(
  '../src/voice/interaction/template-engine-production-runtime.js', import.meta.url,
), 'utf8');
assert.match(source, /retrieveAgentQdrantKnowledge/u);
assert.match(source, /runAgentQdrantGroundedTurn/u);
assert.doesNotMatch(source, /retrieveEvidence|loadPublishedContext|postSearchDecision/u);

console.log(JSON.stringify({
  suite: 'template-engine-production-runtime',
  passed: true,
  retrieval: 'qdrant',
  maximumLlmCallsPerTurn: 1,
  legacyRetrievalBranches: 0,
}));
