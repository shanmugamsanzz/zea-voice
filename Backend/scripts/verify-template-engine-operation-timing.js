import assert from 'node:assert/strict';
import { instrumentTemplateEngineTurn, tagTemplateEngineTiming } from '../src/voice/interaction/template-engine-turn-timing.js';

const events = [];
let retrievalCalls = 0;
let llmCalls = 0;
const measured = instrumentTemplateEngineTurn({
  onStageTiming: (event) => events.push(event),
  retrieveQdrantKnowledge: async (input) => {
    retrievalCalls += 1;
    return { request: input, chunks: [], diagnostics: {} };
  },
  invokeStructuredLlm: async () => {
    llmCalls += 1;
    return { outputParsed: { decision: 'RESPONSE' } };
  },
});

const retrievalInput = { tenantId: 'tenant-1', agentId: 'agent-1', question: 'configured request' };
await measured.retrieveQdrantKnowledge(retrievalInput);
assert.equal(retrievalCalls, 1);
assert.equal(events.at(-1).operation, 'retrieval');

const answerRequest = tagTemplateEngineTiming(Object.freeze({
  responseFormat: { name: 'template_engine_post_search_decision' },
}), 'answer_generation');
await measured.invokeStructuredLlm(answerRequest);
assert.equal(llmCalls, 1);
assert.equal(events.at(-1).operation, 'answer_generation');
assert.equal(events.filter((event) => event.operation === 'answer_generation').length, 1);
assert.ok(events.every((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0));

console.log(JSON.stringify({
  suite: 'template-engine-operation-timing', passed: true,
  retrievalCalls, llmCalls,
}));
