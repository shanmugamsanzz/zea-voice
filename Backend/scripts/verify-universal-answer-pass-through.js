import assert from 'node:assert/strict';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import { parseTemplateEngineStructuredOutput } from '../src/voice/interaction/template-engine-structured-output.js';

const retrieval = {
  request: { tenantId: 'tenant-contract', agentId: 'agent-contract', previousContext: [] },
  chunks: [{ id: 'a', text: 'Item Alpha costs 120.',
    source: { documentId: 'doc', filename: 'items.txt', chunkIndex: 0 } }],
  diagnostics: {},
};

let calls = 0;
let schema;
async function run(answer, selectedRetrieval = retrieval) {
  return runAgentQdrantUniversalTurn({
    retrieval: selectedRetrieval, currentQuestion: 'Alpha price?',
    agentPrompt: 'Use the configured facts.', workflowDefinitions: [],
  }, {
    invokeStructuredLlm: async (request) => {
      calls += 1;
      schema = request.responseFormat.schema;
      return { outputParsed: parseTemplateEngineStructuredOutput({
        completion: { type: 'completed', finishReason: 'stop' },
        output: JSON.stringify({ workflowAction: null, ...answer }),
        schema,
      }) };
    },
  });
}

const accepted = await run({ outcome: 'FACTUAL_ANSWER', speech: 'Alpha costs 999.' });
assert.equal(accepted.speech, 'Alpha costs 999.');
assert.deepEqual(accepted.evidenceIds, ['a']);
assert.deepEqual(schema.required, ['outcome', 'speech', 'workflowAction']);
assert.deepEqual(Object.keys(schema.properties), ['outcome', 'speech', 'workflowAction']);

const withoutChunks = await run(
  { outcome: 'FACTUAL_ANSWER', speech: 'The answer is still spoken.' },
  { ...retrieval, chunks: [] },
);
assert.equal(withoutChunks.speech, 'The answer is still spoken.');
assert.deepEqual(withoutChunks.evidenceIds, []);

for (const [outcome, speech] of [
  ['CLARIFICATION', 'Which item do you mean?'],
  ['UNAVAILABLE', 'I do not have that information.'],
  ['CONVERSATIONAL_RESPONSE', 'Please continue.'],
]) {
  const response = await run({ outcome, speech });
  assert.equal(response.speech, speech);
}
assert.equal(calls, 5);
console.log('Universal answer pass-through contract: passed');
