import assert from 'node:assert/strict';
import { instrumentTemplateEngineTurn, tagTemplateEngineTiming } from '../src/voice/interaction/template-engine-turn-timing.js';
import { summarizeTemplateEngineLatency } from '../src/voice/interaction/template-engine-latency-diagnostics.js';

const events = [];
let expectedRequest;
const response = { unchanged: true, supported: true, resolved: true };
const failure = Object.assign(new Error('cancelled'), { name: 'AbortError' });
const measured = instrumentTemplateEngineTurn({
  onStageTiming: (event) => events.push(event),
  invokeStructuredLlm: async (request) => {
    assert.equal(request, expectedRequest, 'Timing must not change provider inputs');
    if (request.abort) throw failure;
    return response;
  },
  validateGroundedClaims: async () => response,
  validateRequestedEntityCoverage: async () => response,
  validateToolResultSpeechClaims: async () => response,
});
for (const [name, tag, operation] of [
  ['template_engine_orchestrator_decision', 'initial_routing', 'initial_routing'],
  ['template_engine_orchestrator_decision', 'tool_activation_review', 'tool_activation_review'],
  ['template_engine_orchestrator_decision', 'workflow_collection_review_repair', 'workflow_collection_review_repair'],
  ['template_engine_post_search_decision', null, 'answer_generation'],
  ['template_engine_post_search_decision', 'answer_repair', 'answer_repair'],
  ['template_engine_reference_review', null, 'reference_review'],
  ['template_engine_workflow_speech', null, 'workflow_speech_generation'],
  ['unrecognized', null, 'other_llm'],
]) {
  expectedRequest = Object.freeze({ responseFormat: { name }, messages: [{ content: 'private caller data' }] });
  const before = JSON.stringify(expectedRequest);
  if (tag) tagTemplateEngineTiming(expectedRequest, tag);
  assert.equal(await measured.invokeStructuredLlm(expectedRequest), response);
  assert.equal(JSON.stringify(expectedRequest), before);
  assert.equal(events.at(-1).operation, operation);
  assert.ok(events.at(-1).endedAtMs >= events.at(-1).startedAtMs);
  assert.ok(events.at(-1).durationMs >= 0);
}
expectedRequest = { abort: true };
await assert.rejects(() => measured.invokeStructuredLlm(expectedRequest), (error) => error === failure);
assert.equal(events.at(-1).outcome, 'error');
await measured.validateRequestedEntityCoverage({});
assert.equal(events.at(-1).operation, 'entity_coverage_review');
await measured.validateToolResultSpeechClaims({});
assert.equal(events.at(-1).operation, 'tool_result_validation');
await measured.validateGroundedClaims({ speech: 'private caller data' });
await measured.validateGroundedClaims({ speech: 'private caller data' });
assert.equal(events.at(-1).cacheHit, true);
assert.equal(events.at(-1).durationMs, 0);
assert.ok(!JSON.stringify(events).includes('private caller data'));
console.log('Operation timing, unchanged inputs, cancellation and privacy verified.');

// Equivalent full contracts reuse only within a turn and validation operation.
let checks = 0;
let authorizationCalls = 0;
const reuseDependencies = {
  loadPublishedContext: async (input) => {
    checks += 1;
    return { scope: input.scope, artifacts: {}, publishedWorkflows: [] };
  },
  retrieveEvidence: async (input) => {
    checks += 1;
    return { scope: input.scope, evidence: [], diagnostics: {} };
  },
  validateGroundedClaims: async (input) => {
    checks += 1;
    if (input.cancelled) throw failure;
    return { supported: !input.rejected, nested: { unchanged: true } };
  },
  validateRequestedEntityCoverage: async () => { checks += 1; return { resolved: true }; },
  validateToolResultSpeechClaims: async () => { checks += 1; return { supported: true }; },
  invokeStructuredLlm: async () => { authorizationCalls += 1; return response; },
};
const reuse = instrumentTemplateEngineTurn(reuseDependencies);
const contract = { response: 'value', callerValues: { item: 'A' },
  evidence: [{ tenantId: 'one', publicationRevision: 1, content: 'value' }] };
const firstCheck = await reuse.validateGroundedClaims(contract);
firstCheck.nested.unchanged = false;
const repeated = await reuse.validateGroundedClaims({ evidence: contract.evidence,
  callerValues: { item: 'A' }, response: 'value' });
assert.equal(checks, 1, 'Equivalent object-key ordering must not repeat an LLM check');
assert.equal(repeated.nested.unchanged, true, 'Caller mutation must not corrupt cached validation');
for (const changed of [
  { ...contract, response: 'new response' },
  { ...contract, callerValues: { item: 'B' } },
  { ...contract, evidence: [{ ...contract.evidence[0], tenantId: 'two' }] },
  { ...contract, evidence: [{ ...contract.evidence[0], publicationRevision: 2 }] },
  { ...contract, evidence: [{ ...contract.evidence[0], content: 'changed' }] },
]) await reuse.validateGroundedClaims(changed);
assert.equal(checks, 6);
await reuse.validateRequestedEntityCoverage(contract);
await reuse.validateToolResultSpeechClaims(contract);
assert.equal(checks, 8, 'Independent validation purposes must not share approvals');
await reuse.validateRequestedEntityCoverage(contract);
await reuse.validateToolResultSpeechClaims(contract);
assert.equal(checks, 8);
for (let i = 0; i < 2; i += 1) {
  await reuse.validateGroundedClaims({ ...contract, rejected: true });
  await assert.rejects(() => reuse.validateGroundedClaims({ cancelled: true }), (error) => error === failure);
}
assert.equal(checks, 12, 'Negative and cancelled checks must run afresh');
await instrumentTemplateEngineTurn(reuseDependencies).validateGroundedClaims(contract);
assert.equal(checks, 13, 'No reuse across turns');
const publicationContract = { callId: 'call-one', scope: { tenantId: 'one',
  publications: [{ knowledgeBaseId: 'kb', publicationRevision: 1 }] } };
const loaded = await reuse.loadPublishedContext(publicationContract);
loaded.scope.tenantId = 'caller-mutation';
const loadedAgain = await reuse.loadPublishedContext({ scope: {
  publications: [{ publicationRevision: 1, knowledgeBaseId: 'kb' }], tenantId: 'one',
}, callId: 'call-one' });
assert.equal(loadedAgain.scope.tenantId, 'one');
assert.equal(checks, 14, 'Identical publication contract loads once per turn');
await reuse.loadPublishedContext({ ...publicationContract, scope: { ...publicationContract.scope,
  publications: [{ knowledgeBaseId: 'kb', publicationRevision: 2 }] } });
assert.equal(checks, 15, 'Publication revision changes cannot reuse a snapshot');
const retrievalContract = { callId: 'call-one', scope: publicationContract.scope,
  searchDecision: { search: { query: 'same request' } }, preloadedArtifacts: {} };
await Promise.all([reuse.retrieveEvidence(retrievalContract), reuse.retrieveEvidence(retrievalContract)]);
await reuse.retrieveEvidence({ preloadedArtifacts: {}, searchDecision: { search: { query: 'same request' } },
  scope: publicationContract.scope, callId: 'call-one' });
assert.equal(checks, 16, 'Concurrent and completed identical retrievals coalesce per turn');
await reuse.retrieveEvidence({ ...retrievalContract, scope: { ...publicationContract.scope,
  tenantId: 'two' } });
assert.equal(checks, 17, 'Tenant changes cannot reuse retrieval');
await reuse.retrieveEvidence({ ...retrievalContract, reviewEntityCandidates: () => null });
await reuse.retrieveEvidence({ ...retrievalContract, reviewEntityCandidates: () => null });
assert.equal(checks, 19, 'Function-bearing retrieval contracts disable reuse');
const authorization = { responseFormat: { name: 'template_engine_orchestrator_decision' } };
await reuse.invokeStructuredLlm(authorization);
await reuse.invokeStructuredLlm(authorization);
assert.equal(authorizationCalls, 2, 'Routing and authorization calls are never memoized');
console.log('Full-contract validation reuse and independent authorization verified.');

const diagnosis = summarizeTemplateEngineLatency({
  routing: { operations: {
    initial_routing: { durationMs: 1500, calls: 1, cacheHits: 0 },
    grounding_reroute: { durationMs: 1400, calls: 1, cacheHits: 0 },
  } },
  validation: { operations: {
    validation: { durationMs: 1800, calls: 2, cacheHits: 1 },
    entity_coverage_review: { durationMs: 700, calls: 1, cacheHits: 0 },
  } },
  generation: { operations: {
    answer_generation: { durationMs: 2000, calls: 1, cacheHits: 0 },
    answer_repair: { durationMs: 1900, calls: 1, cacheHits: 0 },
  } },
}, { finalAnswerFirstAudioMs: 9700, acknowledgementFirstAudioMs: 900,
  finalAnswerAudioAfterReadyMs: 120 });
assert.equal(diagnosis.actualAnswerFirstAudioMs, 9700);
assert.equal(diagnosis.acknowledgementFirstAudioMs, 900);
assert.equal(diagnosis.answerAudioStartupMs, 120);
assert.equal(diagnosis.llmCalls, 6);
assert.equal(diagnosis.reviewCalls, 1);
assert.equal(diagnosis.repairCalls, 2);
assert.deepEqual(diagnosis.repeatedOperations, [{
  operation: 'validation', calls: 2, cacheHits: 1, durationMs: 1800,
}]);
assert.equal(diagnosis.slowestOperations[0].operation, 'answer_generation');
assert.ok(!JSON.stringify(diagnosis).includes('private caller data'));
