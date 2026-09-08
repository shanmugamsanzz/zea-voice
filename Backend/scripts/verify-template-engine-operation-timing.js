import assert from 'node:assert/strict';
import { instrumentTemplateEngineTurn, tagTemplateEngineTiming } from '../src/voice/interaction/template-engine-turn-timing.js';

const events = [];
let publicationCalls = 0;
let retrievalCalls = 0;
let llmCalls = 0;
const measured = instrumentTemplateEngineTurn({
  onStageTiming: (event) => events.push(event),
  loadPublishedContext: async (input) => {
    publicationCalls += 1;
    return { scope: input.scope, artifacts: {}, publishedWorkflows: [] };
  },
  retrieveEvidence: async (input) => {
    retrievalCalls += 1;
    return { scope: input.scope, evidence: [], diagnostics: {} };
  },
  invokeStructuredLlm: async () => {
    llmCalls += 1;
    return { outputParsed: { decision: 'RESPONSE' } };
  },
});

const scope = { tenantId: 'tenant-1', publications: [{ knowledgeBaseId: 'kb-1', publicationRevision: 2 }] };
const publicationInput = { callId: 'call-1', scope };
await measured.loadPublishedContext(publicationInput);
await measured.loadPublishedContext(structuredClone(publicationInput));
assert.equal(publicationCalls, 1);

const retrievalInput = { callId: 'call-1', scope, latestUtterance: 'configured request' };
await Promise.all([measured.retrieveEvidence(retrievalInput), measured.retrieveEvidence(retrievalInput)]);
assert.equal(retrievalCalls, 1);
await measured.retrieveEvidence({ ...retrievalInput, latestUtterance: 'changed request' });
assert.equal(retrievalCalls, 2);

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
  publicationCalls, retrievalCalls, llmCalls,
}));
