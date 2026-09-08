import assert from 'node:assert/strict';
import {
  assertSingleLlmTurnArchitecture,
  createSingleLlmTurnInvoker,
  enforceVerifiedFactualArchitecture,
} from '../src/voice/interaction/template-engine-production-runtime.js';
import { assertVerifiedFactualStageArchitecture } from '../src/voice/interaction/template-engine-turn-timing.js';

let providerCalls = 0;
const guarded = createSingleLlmTurnInvoker(async () => {
  providerCalls += 1;
  return { outputParsed: { decision: 'RESPONSE' } };
});
const request = Object.freeze({ responseFormat: Object.freeze({
  type: 'json_schema', name: 'template_engine_post_search_decision',
}) });
await guarded.invoke(request);
await assert.rejects(() => guarded.invoke(request), {
  code: 'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED',
});
assert.equal(providerCalls, 1);
assert.equal(guarded.count(), 1);

assert.deepEqual(assertSingleLlmTurnArchitecture({
  invocationCount: 0, turnKind: 'conversational_control',
}), {
  enforced: true, invocationCount: 0, maximumInvocations: 1,
  exactlyOneRequired: false, turnKind: 'conversational_control',
});
assert.equal(assertSingleLlmTurnArchitecture({
  invocationCount: 1, requireExactlyOne: true, turnKind: 'factual',
}).invocationCount, 1);
assert.throws(() => assertSingleLlmTurnArchitecture({ invocationCount: 2 }), {
  code: 'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED',
});
assert.throws(() => assertSingleLlmTurnArchitecture({
  invocationCount: 0, requireExactlyOne: true, turnKind: 'factual',
}), { code: 'TEMPLATE_ENGINE_ARCHITECTURE_VIOLATION' });

const architecture = enforceVerifiedFactualArchitecture({
  deterministicAnswerPath: true,
  answered: {
    decision: { decision: 'RESPONSE' },
    diagnostics: { verifiedAnswerFastPath: true, answerGenerationCalls: 1 },
  },
});
assert.equal(architecture.path, 'verified_factual_one_llm');
assert.deepEqual(architecture.stages, [
  'deterministic_resolution', 'focused_retrieval', 'grounded_answer_generation',
  'deterministic_validation', 'tts_ready',
]);

const measured = assertVerifiedFactualStageArchitecture({
  architecture,
  stageTimings: {
    publication: { operations: { publication_load: { calls: 1 } } },
    retrieval: { operations: { retrieval: { calls: 1 } } },
    generation: { operations: { answer_generation: { calls: 1 } } },
  },
});
assert.equal(measured.calls.answerGeneration, 1);
assert.equal(measured.calls.otherLlm, 0);

console.log(JSON.stringify({
  suite: 'template-engine-production-runtime', passed: true,
  deterministicResolution: true, focusedRetrieval: true,
  maximumLlmCallsPerTurn: 1, deterministicValidation: true,
}));
