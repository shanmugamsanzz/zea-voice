import assert from 'node:assert/strict';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import { parseTemplateEngineStructuredOutput } from '../src/voice/interaction/template-engine-structured-output.js';

const retrieval = {
  request: { tenantId: 'tenant-contract', agentId: 'agent-contract', previousContext: [] },
  chunks: [{ id: 'a', text: 'Item Alpha costs 120. Item Beta costs 240.',
    source: { documentId: 'doc', filename: 'items.txt', chunkIndex: 0 } }],
  diagnostics: {},
};
const valid = {
  outcome: 'FACTUAL_ANSWER', speech: 'Alpha costs 120.', evidenceIds: ['a'], workflowAction: null,
  grounding: { answersRequestedSubject: true, answersRequestedAttribute: true,
    supports: [{ claim: 'Alpha costs 120.', evidenceId: 'a', quote: 'Item Alpha costs 120.' }] },
};
let calls = 0;
let schema;
async function run(answer) {
  const before = calls;
  try {
    return await runAgentQdrantUniversalTurn({ retrieval, currentQuestion: 'Alpha price?',
      agentPrompt: 'Use the configured facts.', workflowDefinitions: [] }, {
      invokeStructuredLlm: async (request) => {
        calls += 1;
        schema = request.responseFormat.schema;
        return { outputParsed: parseTemplateEngineStructuredOutput({
          completion: { type: 'completed', finishReason: 'stop' },
          output: JSON.stringify({ actionAuthorization: null, ...answer }), schema,
        }) };
      },
    });
  } finally { assert.equal(calls - before, 1); }
}
const accepted = await run(valid);
assert.equal(accepted.grounding.excerptProvenanceVerified, true);
assert.equal(accepted.decision.grounding.supports[0].quote, 'Item Alpha costs 120.');
assert.ok(schema.required.includes('grounding'));

for (const flag of ['answersRequestedSubject', 'answersRequestedAttribute']) {
  await assert.rejects(() => run({ ...valid, grounding: { ...valid.grounding, [flag]: false } }),
    { code: 'QDRANT_UNIVERSAL_LLM_REQUEST_SUPPORT_INVALID' });
}
await assert.rejects(() => run({ ...valid, grounding: null }),
  { code: 'QDRANT_UNIVERSAL_LLM_REQUEST_SUPPORT_INVALID' });
await assert.rejects(() => run({ ...valid, grounding: { ...valid.grounding, supports: [
  { ...valid.grounding.supports[0], quote: 'Alpha includes an invented service.' },
] } }), { code: 'QDRANT_UNIVERSAL_LLM_CLAIM_SUPPORT_INVALID' });
await assert.rejects(() => run({ ...valid, speech: 'Alpha costs 240.',
  grounding: { ...valid.grounding, supports: [
    { ...valid.grounding.supports[0], claim: 'Alpha costs 240.' },
  ] } }), { code: 'QDRANT_UNIVERSAL_LLM_NUMBER_INVALID' });
await assert.rejects(() => run({ ...valid, grounding: { ...valid.grounding, supports: [
  { claim: 'Alpha costs 120.', evidenceId: 'a' },
] } }), { code: 'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID' });

const translated = await run({ ...valid, speech: 'Alpha விலை 120.',
  grounding: { ...valid.grounding, supports: [
    { ...valid.grounding.supports[0], claim: 'Alpha விலை 120.' },
  ] } });
assert.equal(translated.speech, 'Alpha விலை 120.');
const comparison = await run({ ...valid, speech: 'Alpha costs 120; Beta costs 240.',
  grounding: { ...valid.grounding, supports: [
    { claim: 'Alpha costs 120', evidenceId: 'a', quote: 'Item Alpha costs 120.' },
    { claim: 'Beta costs 240.', evidenceId: 'a', quote: 'Item Beta costs 240.' },
  ] } });
assert.equal(comparison.grounding.supports.length, 2);
for (const [outcome, speech] of [
  ['CLARIFICATION', 'Which of the previously mentioned items do you mean?'],
  ['UNAVAILABLE', 'I do not have verified information about that detail.'],
  ['CONVERSATIONAL_RESPONSE', 'Please continue.'],
]) {
  const response = await run({ outcome, speech, grounding: null,
    evidenceIds: [], workflowAction: null });
  assert.equal(response.speech, speech);
  assert.equal(response.grounding, null);
}
console.log('Universal grounding contract: passed (one call per case)');
