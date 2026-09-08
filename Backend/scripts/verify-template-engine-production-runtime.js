import assert from 'node:assert/strict';
import {
  classifyTemplateEngineSearch,
  constrainHybridToRequestedEntities,
  deterministicPublishedRequestDecision,
  retrieveTemplateEngineEvidence,
} from '../src/voice/interaction/template-engine-production-retrieval.js';
import {
  deterministicAcknowledgementDecision,
  deterministicConfirmedContextualReference,
  deterministicPendingWorkflowFieldDecision,
  reviewPendingTextWorkflowField,
  publishedResolutionAmbiguity,
  runTemplateEngineProductionTurn,
  verifiedPublishedEntityFastPath,
  sameSpeculativeRetrievalBoundary,
} from '../src/voice/interaction/template-engine-production-runtime.js';
import { recordTemplateEngineTurnMetrics, templateEngineAudioPercentiles } from '../src/voice/interaction/template-engine-observability.js';
import { instrumentTemplateEngineTurn } from '../src/voice/interaction/template-engine-turn-timing.js';
import { reviewRememberedReference } from '../src/voice/interaction/template-engine-reference-review.js';
import { resolveRequestMeaning } from '../src/voice/interaction/template-engine-request-meaning.js';
import { reviewMultilingualEntity } from '../src/voice/interaction/template-engine-multilingual-entity-review.js';
import { reviewContextualSubjects } from '../src/voice/interaction/template-engine-contextual-subject-review.js';

const multilingualCandidates = [{ canonicalName: 'Configured Alpha', recordId: 'alpha', aliases: [] },
  { canonicalName: 'Configured Beta', recordId: 'beta', aliases: [] }];
const scalarWorkflowContext = { toolName: 'configured_action', pendingFieldKey: 'quantity',
  awaitingConfirmation: false, interruptedRequest: null,
  fields: [{ key: 'quantity', question: 'What quantity?', type: 'number',
    schema: { type: 'number', minimum: 1, maximum: 100 } }] };
assert.deepEqual(deterministicPendingWorkflowFieldDecision(scalarWorkflowContext, '21')?.tool?.arguments,
  { quantity: 21 });
for (const utterance of ['age is 21', '21 or 22', 'cancel 21', 'what about 21?']) {
  assert.equal(deterministicPendingWorkflowFieldDecision(scalarWorkflowContext, utterance), null);
}
assert.equal(deterministicPendingWorkflowFieldDecision({ ...scalarWorkflowContext,
  awaitingConfirmation: true }, '21'), null);
assert.equal(deterministicPendingWorkflowFieldDecision({ ...scalarWorkflowContext,
  interruptedRequest: 'unfinished request' }, '21'), null);
assert.deepEqual(deterministicPendingWorkflowFieldDecision({ ...scalarWorkflowContext,
  fields: [{ key: 'quantity', question: 'Name?', type: 'text', schema: { type: 'string' } }] },
'Shanmugam')?.tool?.arguments, { quantity: 'Shanmugam' },
'An exact scalar for a configured pending text field bypasses intent routing');
assert.equal(deterministicPendingWorkflowFieldDecision({ ...scalarWorkflowContext,
  fields: [{ key: 'quantity', question: 'Name?', type: 'text', schema: { type: 'string' } }] },
'Okay', { excludedPhrases: ['Okay'] }), null,
'A configured acknowledgement must not be stored as a text-field value');
assert.equal(deterministicAcknowledgementDecision({
  utterance: 'Okay', acknowledgementPhrases: ['Okay'],
}), null, 'An acknowledgement without a configured pending question remains on the semantic path');
assert.equal(deterministicAcknowledgementDecision({
  utterance: 'Okay', acknowledgementPhrases: ['Okay'], pendingQuestion: { text: 'Continue?' },
})?.clarification?.question, 'Continue?',
'An exact acknowledgement may replay the configured pending question without routing');
assert.deepEqual(deterministicAcknowledgementDecision({
  utterance: 'Okay', acknowledgementPhrases: ['Okay'], workflowContext: {
    toolName: 'configured_action', pendingFieldKey: 'contact_value',
    awaitingConfirmation: false, interruptedRequest: null,
  },
})?.tool?.arguments, {},
'An acknowledgement during collection advances no field and lets the workflow repeat its pending question');
const deterministicPublicationScope = {
  tenantId: 'tenant-fast-path', agentId: 'agent-fast-path', publications: [{
    knowledgeBaseId: 'kb-fast-path', publicationRevision: 2,
  }],
};
const deterministicPublicationArtifacts = { bundles: [{
  tenantId: 'tenant-fast-path', agentId: 'agent-fast-path',
  knowledgeBaseId: 'kb-fast-path', publicationRevision: 2,
  records: [
    { record_id: 'item-alpha', record_type: 'CATALOG_ITEM', usage_direction: 'both',
      entity_name: 'Configured Alpha', entity_aliases: ['Alpha'],
      entity_category: 'Configured Group', category_key: 'configured-group' },
    { record_id: 'item-beta', record_type: 'CATALOG_ITEM', usage_direction: 'both',
      entity_name: 'Configured Beta', entity_aliases: ['Beta'],
      entity_category: 'Configured Group', category_key: 'configured-group' },
  ],
}] };
assert.deepEqual(deterministicPublishedRequestDecision({
  artifacts: deterministicPublicationArtifacts, scope: deterministicPublicationScope,
  usageDirection: 'inbound', latestUtterance: 'Alpha',
})?.search?.preferredRecordIds, ['item-alpha'],
'One exact published alias may bypass semantic routing');
assert.equal(deterministicPublishedRequestDecision({
  artifacts: deterministicPublicationArtifacts, scope: deterministicPublicationScope,
  usageDirection: 'inbound', latestUtterance: 'Tell me about Alpha',
}), null, 'Phrase-contained requests retain the semantic route');
assert.deepEqual(deterministicPublishedRequestDecision({
  artifacts: deterministicPublicationArtifacts, scope: deterministicPublicationScope,
  usageDirection: 'inbound', latestUtterance: 'Configured Group',
})?.search?.preferredRecordIds, [],
'One exact published category uses category retrieval without becoming a comparison');
assert.equal(deterministicPublishedRequestDecision({
  artifacts: deterministicPublicationArtifacts,
  scope: { ...deterministicPublicationScope, publications: [{
    knowledgeBaseId: 'kb-fast-path', publicationRevision: 1,
  }] },
  usageDirection: 'inbound', latestUtterance: 'Alpha',
}), null, 'A stale publication revision must never activate the deterministic fast path');
const textWorkflowContext = { ...scalarWorkflowContext, pendingFieldKey: 'contact_value',
  fields: [{ key: 'contact_value', question: 'What value should be recorded?',
    type: 'text', schema: { type: 'string', minLength: 2, maxLength: 100 } }] };
const acceptedText = await reviewPendingTextWorkflowField(
  textWorkflowContext, 'Shanmugam', async (request) => {
    assert.equal(request.responseFormat.name, 'template_engine_pending_text_field');
    return { outputParsed: { classification: 'field_value', value: 'Shanmugam' } };
  },
);
assert.deepEqual(acceptedText?.tool?.arguments, { contact_value: 'Shanmugam' });
for (const classification of ['cancellation', 'correction', 'question', 'other', 'unclear']) {
  assert.equal(await reviewPendingTextWorkflowField(textWorkflowContext, 'stop', async () => ({
    outputParsed: { classification, value: null },
  })), null, `${classification} must retain normal workflow routing`);
}
assert.equal(await reviewPendingTextWorkflowField(textWorkflowContext, 'Shanmugam', async () => ({
  outputParsed: { classification: 'field_value', value: 'translated value' },
})), null, 'A transformed or invented text value must not enter workflow state');
assert.equal(deterministicConfirmedContextualReference({
  search: { contextualReference: 'confirmed selection', preferredRecordIds: ['record-1'] },
  state: { lastReferencedRecordIds: ['record-1'], comparisonRecordIds: [],
    pendingClarification: { candidates: ['Configured selection'] } },
}), true, 'A structurally confirmed reference may reuse the exact remembered record');
assert.equal(deterministicConfirmedContextualReference({
  search: { contextualReference: 'uncertain selection', preferredRecordIds: ['record-2'] },
  state: { lastReferencedRecordIds: ['record-1'], comparisonRecordIds: [],
    pendingClarification: { candidates: ['Configured selection'] } },
}), false, 'A mismatched remembered record must retain semantic reference review');
const multilingualInput = { utterance: 'கான்ஃபிகர்ட் ஆல்பா', candidates: multilingualCandidates,
  recentTurns: [{ role: 'assistant', content: 'Configured Beta details' }] };
assert.deepEqual(await reviewContextualSubjects({ ...multilingualInput, utterance: 'What tests does that include?' },
  async () => ({ relation: 'reference', subjectIds: ['S2'] })), [multilingualCandidates[1]]);
for (const result of [{ relation: 'new_subject', subjectIds: ['S2'] },
  { relation: 'uncertain', subjectIds: [] }, { relation: 'reference', subjectIds: ['foreign'] }]) {
  assert.equal(await reviewContextualSubjects(multilingualInput, async () => result), null);
}
await assert.rejects(() => reviewContextualSubjects(multilingualInput, async () => {
  throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}), { name: 'AbortError' });
assert.equal(await reviewMultilingualEntity(multilingualInput, async () => ({ outputParsed: {
  relation: 'equivalent', candidateId: 'C1',
} })), multilingualCandidates[0], 'New cross-script subject must not become the previous subject');
for (const output of [{ relation: 'uncertain', candidateId: 'C1' },
  { relation: 'unrelated', candidateId: null }, { relation: 'equivalent', candidateId: 'foreign' }, null]) {
  assert.equal(await reviewMultilingualEntity(multilingualInput, async () => output), null);
}
await assert.rejects(() => reviewMultilingualEntity(multilingualInput, async () => {
  throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}), { name: 'AbortError' });

const welcomeMeaningInput = { latestUtterance: 'Yes', welcomeContinuation: {
  pendingQuestion: { text: 'Is this the account holder?' },
  candidates: [{ recordId: 'published-next', purpose: 'Explain available services.' }],
} };
for (const output of [null, 'malformed', { continuation: true, guidanceRecordId: 'invented',
  query: 'services', requestedFact: 'overview' }, { continuation: true, guidanceRecordId: 'published-next',
  query: {}, requestedFact: 'overview' }]) {
  assert.equal((await resolveRequestMeaning(welcomeMeaningInput, async () => output)).kind, 'direct_request');
}
for (const latestUtterance of ['No thanks', 'Wrong person', 'No, I meant another service',
  'What services do you offer?', 'என்னென்ன சேவைகள் இருக்கு?']) {
  const meaning = await resolveRequestMeaning({ ...welcomeMeaningInput, latestUtterance }, async (request) => {
    assert.ok(request.messages[0].content.includes('new request, correction, refusal or wrong-person'));
    return { continuation: false, guidanceRecordId: null, query: null, requestedFact: null };
  });
  assert.equal(meaning.originalUtterance, latestUtterance);
  assert.equal(meaning.publishedNextStep, null);
}
assert.equal((await resolveRequestMeaning({ latestUtterance: 'Show all services' }, async () => {
  throw new Error('Ordinary direct requests need no welcome review');
})).originalUtterance, 'Show all services');
await assert.rejects(() => resolveRequestMeaning(welcomeMeaningInput, async () => {
  throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}), { name: 'AbortError' });

let validationInvocations = 0;
const timingEvents = [];
const timed = instrumentTemplateEngineTurn({
  onStageTiming: (event) => timingEvents.push(event),
  validateGroundedClaims: async (input) => {
    validationInvocations += 1;
    if (input.cancelled) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    return { supported: input.response === 'supported' };
  },
});
const validationInput = { response: 'supported', citedEvidence: [{ tenantId: 'a', publicationRevision: 1 }] };
await Promise.all([timed.validateGroundedClaims(validationInput), timed.validateGroundedClaims(validationInput)]);
assert.equal(validationInvocations, 1, 'Identical concurrent validation reuses one check within a turn');
await timed.validateGroundedClaims({ ...validationInput, response: 'changed' });
await timed.validateGroundedClaims({ ...validationInput, citedEvidence: [{ tenantId: 'b', publicationRevision: 1 }] });
await timed.validateGroundedClaims({ ...validationInput, citedEvidence: [{ tenantId: 'a', publicationRevision: 2 }] });
assert.equal(validationInvocations, 4, 'Changed speech, tenant or publication must be revalidated');
for (let attempt = 0; attempt < 2; attempt += 1) {
  await assert.rejects(() => timed.validateGroundedClaims({ cancelled: true }), { name: 'AbortError' });
}
assert.equal(validationInvocations, 6, 'Cancelled checks must not be cached');
assert.ok(timingEvents.some((event) => event.cacheHit));
assert.ok(timingEvents.every((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0));
const audioPercentiles = templateEngineAudioPercentiles([
  { acknowledgementFirstAudioMs: 750, finalAnswerFirstAudioMs: 10000 },
  { acknowledgementFirstAudioMs: null, finalAnswerFirstAudioMs: 12000 },
  { acknowledgementFirstAudioMs: undefined, finalAnswerFirstAudioMs: null },
]);
assert.equal(audioPercentiles.acknowledgement.count, 1);
assert.equal(audioPercentiles.finalAnswer.count, 2);
assert.equal(audioPercentiles.finalAnswer.p90, 12000, 'Acknowledgements must never improve answer latency percentiles');
assert.deepEqual(audioPercentiles.actualAnswerUnderThreeSeconds, {
  targetMs: 3000, maximumMs: 4000, minimumSamples: 20, measured: 2, passed: 0, passRate: 0,
  averageMs: 11000, averageTargetStatus: 'insufficient_live_samples',
  maximumObservedMs: 12000, maximumTargetStatus: 'insufficient_live_samples',
  p95: 12000, p95TargetStatus: 'insufficient_live_samples',
});
const liveTargetSamples = Array.from({ length: 20 }, (_, index) => ({
  finalAnswerFirstAudioMs: 2_500 + index,
  acknowledgementFirstAudioMs: 500,
}));
assert.equal(templateEngineAudioPercentiles(liveTargetSamples)
  .actualAnswerUnderThreeSeconds.p95TargetStatus, 'passed');
assert.equal(templateEngineAudioPercentiles(liveTargetSamples)
  .actualAnswerUnderThreeSeconds.averageTargetStatus, 'passed');
liveTargetSamples[18].finalAnswerFirstAudioMs = 3_100;
liveTargetSamples[19].finalAnswerFirstAudioMs = 3_200;
assert.equal(templateEngineAudioPercentiles(liveTargetSamples)
  .actualAnswerUnderThreeSeconds.p95TargetStatus, 'missed',
'Acknowledgement speed must not hide an actual-answer P95 breach');
assert.equal(templateEngineAudioPercentiles(liveTargetSamples)
  .actualAnswerUnderThreeSeconds.averageTargetStatus, 'passed',
'Average and P95 actual-answer targets must be reported independently');

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const publication = { knowledgeBaseId, publicationRevision: 4 };
const scope = { tenantId, agentId, publications: [publication] };
const speculativeBoundary = Object.freeze({
  tenantId, agentId, publications: Object.freeze([`${knowledgeBaseId}:4`]),
  request: 'tenant item price', turn: 'call-boundary:7',
});
assert.equal(sameSpeculativeRetrievalBoundary(speculativeBoundary, {
  latestUtterance: 'Tenant Item Price', callId: 'call-boundary', turnEpoch: 7,
}, scope), true);
for (const mismatch of [
  { input: { latestUtterance: 'another request', callId: 'call-boundary', turnEpoch: 7 }, scope },
  { input: { latestUtterance: 'tenant item price', callId: 'call-boundary', turnEpoch: 8 }, scope },
  { input: { latestUtterance: 'tenant item price', callId: 'call-boundary', turnEpoch: 7 },
    scope: { ...scope, tenantId: 'another-tenant' } },
  { input: { latestUtterance: 'tenant item price', callId: 'call-boundary', turnEpoch: 7 },
    scope: { ...scope, publications: [{ knowledgeBaseId, publicationRevision: 5 }] } },
]) {
  assert.equal(sameSpeculativeRetrievalBoundary(speculativeBoundary, mismatch.input, mismatch.scope), false,
    'Speculative retrieval must not cross request, turn, tenant, or publication boundaries');
}
const ambiguousCandidates = [
  { recordId: 'record-a', recordType: 'CATALOG_ITEM', label: 'Option A' },
  { recordId: 'record-b', recordType: 'CATALOG_ITEM', label: 'Option B' },
];
const fuzzyAmbiguity = {
  ambiguity: { detected: true, candidates: ambiguousCandidates },
  routingCandidates: ambiguousCandidates, requiresCandidateConfirmation: true,
};
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, [{
  recordId: 'record-a', recordType: 'CATALOG_ITEM', verified: true,
}], { searchKind: 'named_entity' }).required, true,
'Hydration alone must not clear fuzzy identity uncertainty');
const genuineAmbiguity = publishedResolutionAmbiguity(fuzzyAmbiguity, [
  { recordId: 'record-a', recordType: 'CATALOG_ITEM', verified: true },
  { recordId: 'record-b', recordType: 'CATALOG_ITEM', verified: true },
], { searchKind: 'named_entity' });
assert.equal(genuineAmbiguity.required, true);
assert.deepEqual(genuineAmbiguity.candidates, ['Option A', 'Option B']);
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, ambiguousCandidates.map((entry) => ({
  ...entry, verified: true,
})), { searchKind: 'comparison', requestedEntityRecordIds: ['record-a', 'record-b'] }).required,
false, 'Fully hydrated comparison operands are not ambiguous alternatives');
assert.throws(() => publishedResolutionAmbiguity(fuzzyAmbiguity, [], {
  searchKind: 'comparison', requestedEntityRecordIds: ['record-a', 'record-b'],
}), { code: 'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE' },
'Known operands without hydration are a retrieval failure, not unclear caller intent');
assert.equal(publishedResolutionAmbiguity({ action: 'CONTINUE' }, [
  { recordId: 'record-a', verified: true },
], { searchKind: 'comparison', requestedEntityRecordIds: ['record-a'] }).required, true,
'One remembered operand cannot resolve a comparison');
assert.equal(publishedResolutionAmbiguity(fuzzyAmbiguity, [], {
  searchKind: 'overview',
}).required, false, 'A general overview must not clarify between its listed entities');

for (const scenario of [
  {
    expected: 'overview', search: { requestedFact: 'available options' },
    conversationGuidance: { intentClass: 'CATEGORY_OVERVIEW' },
  },
  {
    expected: 'category', search: {},
    resolution: { candidate: { entityType: 'CATEGORY' }, candidateNamespace: 'CATALOG' },
  },
  {
    expected: 'named_entity', search: {},
    resolution: { candidate: { entityType: 'ITEM' }, candidateNamespace: 'CATALOG' },
  },
  {
    expected: 'contextual_follow_up',
    search: { contextualReference: 'current selection', preferredRecordIds: ['record-a'] },
  },
  {
    expected: 'comparison',
    search: { requestedFact: 'comparison', preferredRecordIds: ['record-a', 'record-b'] },
  },
  { expected: 'general_knowledge', search: { requestedFact: 'published fact' } },
]) {
  assert.equal(classifyTemplateEngineSearch(scenario).searchKind, scenario.expected);
}

const identityCandidate = (recordId, overrides = {}) => ({
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId, recordType: 'CATALOG_ITEM', ...overrides,
});
const requestedA = identityCandidate('record-a');
const requestedB = identityCandidate('record-b');
const duplicateA = identityCandidate('record-a', { score: 0.7 });
const unrelated = identityCandidate('record-unrelated');
const stale = identityCandidate('record-stale', { publicationRevision: 3 });
const foreign = identityCandidate('record-foreign', {
  tenantId: '99999999-9999-4999-8999-999999999999',
});
const constrainedComparison = constrainHybridToRequestedEntities({
  channels: {
    structured: [requestedA, duplicateA, unrelated, stale, foreign],
    bm25: [requestedB, unrelated],
    qdrant: [requestedA, requestedB, foreign],
  },
  candidates: [requestedA, duplicateA, requestedB, unrelated, stale, foreign],
  queryContext: {
    reservedRecords: [
      { ...requestedA, reason: 'explicit_comparison' },
      { ...requestedB, reason: 'explicit_comparison' },
      { ...stale, reason: 'explicit_comparison' },
    ],
  },
}, tenantId, null, scope);
assert.equal(constrainedComparison.comparison, true);
assert.deepEqual(new Set(constrainedComparison.hybrid.candidates.map((value) => value.recordId)),
  new Set(['record-a', 'record-b']));
assert.equal(constrainedComparison.hybrid.channels.structured.length, 1);
assert.equal(constrainedComparison.hybrid.channels.bm25.length, 1);
assert.equal(constrainedComparison.hybrid.channels.qdrant.length, 2);

const currentExplicit = identityCandidate('record-current', {
  canonicalName: 'Current Published Choice', explicit: true,
});
const staleContextConstraint = constrainHybridToRequestedEntities({
  channels: { structured: [requestedA, requestedB, currentExplicit] },
  candidates: [requestedA, requestedB, currentExplicit],
  queryContext: { reservedRecords: [
    { ...requestedA, reason: 'canonical_memory' },
    { ...requestedB, reason: 'contextual_comparison' },
  ] },
}, tenantId, {
  candidate: { ...currentExplicit, entityType: 'ITEM', explicit: true },
  ambiguity: { detected: false, candidates: [] },
}, scope);
assert.deepEqual(staleContextConstraint.requestedRecordIds, ['record-current'],
  'A verified entity named in the current turn must replace stale memory');
assert.deepEqual(staleContextConstraint.hybrid.candidates.map((value) => value.recordId),
  ['record-current']);

const categoryConstrained = constrainHybridToRequestedEntities({
  channels: { structured: [requestedA, requestedB, unrelated] },
  candidates: [requestedA, requestedB, unrelated],
  queryContext: { reservedRecords: [] },
}, tenantId, {
  candidate: {
    ...identityCandidate('synthetic-category', { recordType: 'CATALOG_CATEGORY' }),
    evidenceRecordIds: ['record-a', 'record-b'],
  },
}, scope);
assert.deepEqual(new Set(categoryConstrained.hybrid.candidates.map((value) => value.recordId)),
  new Set(['record-a', 'record-b']));
const searchDecision = {
  decision: 'SEARCH', response: '', clarification: null,
  search: { query: 'tenant item price', requestedFact: 'price', contextualReference: 'tenant item', preferredRecordIds: [] },
  tool: null, nextQuestion: null, stateUpdate: null,
};
let channelCalls = 0;
let hydrationCalls = 0;
const candidate = {
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId: 'record-1', recordType: 'CATALOG_ITEM', score: 0.9,
  callerFacingHint: true, canonicalName: 'Tenant Item', searchForms: ['tenant item'],
  matchMethod: 'published_exact',
};
const retrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-1', usageDirection: 'inbound',
  language: 'ta', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => {
    channelCalls += 1;
    return { channels: { structured: [candidate], bm25: [candidate], qdrant: [candidate] } };
  },
  hydrateEvidence: async ({
    retrieval: selected, requireAtLeastOneHydratedEvidence, selectionRetry,
  }) => {
    hydrationCalls += 1;
    assert.equal(selected.candidates.length, 1);
    assert.equal(requireAtLeastOneHydratedEvidence, true);
    for (const channelCandidates of Object.values(selected.channels)) {
      assert.equal(channelCandidates[0].tenantId, tenantId);
      assert.equal(channelCandidates[0].agentId, agentId);
      assert.equal(channelCandidates[0].knowledgeBaseId, knowledgeBaseId);
      assert.equal(channelCandidates[0].publicationRevision, 4);
      assert.equal(channelCandidates[0].recordType, 'CATALOG_ITEM');
      assert.equal(channelCandidates[0].recordId, 'record-1');
    }
    if (hydrationCalls === 1) {
      assert.notEqual(selectionRetry, true);
      return { evidence: [], fusion: { candidates: selected.candidates } };
    }
    assert.equal(selectionRetry, true);
    return { evidence: [{
      ...candidate, id: 'evidence-1', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: 'Tenant Item costs 125.', authoritativeData: {
        name: 'Tenant Item', price: 125,
        attributes: [{ key: 'published_detail', value: 'Approved value' }],
      },
      provenance: {
        knowledgeBaseId, publicationRevision: 4,
        documentId: 'document-1', documentVersionId: 'document-version-1',
        uploadedFilename: 'tenant-source.txt', documentDisplayName: 'Tenant Source',
        documentType: 'catalog', pageNumber: 1, pageEnd: 1,
        sourceSection: 'Approved values', sourceLineStart: 10, sourceLineEnd: 12,
      },
    }] };
  },
});
assert.equal(channelCalls, 1);
assert.equal(hydrationCalls, 2);
assert.equal(retrieval.evidence.length, 1);
assert.equal(retrieval.evidence[0].verified, true);
assert.equal(retrieval.evidence[0].documentName, 'tenant-source.txt');
assert.equal(retrieval.evidence[0].documentDisplayName, 'Tenant Source');
assert.equal(retrieval.evidence[0].pageNumber, 1);
assert.equal(retrieval.evidence[0].sourceLineStart, 10);
assert.equal(retrieval.evidence[0].sourceLineEnd, 12);
assert.equal(retrieval.evidence[0].requestedFact, 'price');
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('price'), true);
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('attributes.key'), true);
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('unpublished_detail'), false);
assert.deepEqual(retrieval.diagnostics.channelCounts, {
  structured: 1, bm25: 1, qdrant: 1,
});
assert.equal(retrieval.diagnostics.retrievalCount, 1);
assert.equal(retrieval.diagnostics.hydrationCount, 1);
assert.equal(retrieval.diagnostics.verifiedEvidenceCount, 1);
assert.equal(retrieval.diagnostics.selectionRetryAttempted, true);
assert.equal(Number.isFinite(retrieval.diagnostics.durationMs), true);
assert.equal(retrieval.diagnostics.durationMs >= 0, true);

const exactRecord = {
  record_id: 'record-exact', record_type: 'catalog_item',
  entity_name: 'Configured Alpha', entity_category: 'Configured Group',
  entity_aliases: ['Alpha Alias'], entity_category_aliases: ['Group Alias'],
  usage_direction: 'both', content: 'Configured Alpha approved details.',
  entity_metadata: { itemKey: 'configured-alpha', categoryKey: 'configured-group' },
};
const sttVariantRecord = {
  record_id: 'record-stt-variant', record_type: 'catalog_item',
  entity_name: 'Configured Beta', entity_category: 'Configured Group',
  publicationSttForms: ['Betacopy'], publicationPhoneticForms: ['Beta copy'],
  usage_direction: 'both', content: 'Configured Beta approved details.',
  entity_metadata: { itemKey: 'configured-beta', categoryKey: 'configured-group' },
};
const foreignSttVariantRecord = {
  ...sttVariantRecord, record_id: 'foreign-record-stt-variant',
  entity_name: 'Foreign Beta', content: 'Foreign tenant content.',
};
const exactArtifacts = {
  publications: [publication], sparseIndexes: [],
  bundles: [{
    tenantId, knowledgeBaseId, publicationRevision: 4, assignedAgentIds: [agentId],
    records: [exactRecord],
  }],
};
let exactStructuredRecords = [];
const exactRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-exact', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Alpha Alias', requestedFact: 'details',
      contextualReference: 'Alpha Alias', preferredRecordIds: [],
    },
  }, state: {},
  reviewEntityCandidates: async () => assert.fail(
    'Published exact identity must not invoke multilingual clarification review',
  ),
}, {
  loadArtifacts: async () => exactArtifacts,
  searchCandidates: async () => ({
    channels: {
      structured: [],
      bm25: [{ ...candidate, recordId: 'unrelated-record', canonicalName: 'Other Record' }],
      qdrant: [{ ...candidate, recordId: 'unrelated-record', canonicalName: 'Other Record' }],
    },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    exactStructuredRecords = selected.channels.structured;
    assert.deepEqual(selected.candidates.map((entry) => entry.recordId), ['record-exact']);
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-exact', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: 'Configured Alpha approved details.',
      authoritativeData: { name: 'Configured Alpha', detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.equal(exactStructuredRecords.length, 1,
  'Published exact matching must populate the structured channel');
assert.equal(exactStructuredRecords[0].recordId, 'record-exact');
assert.equal(exactStructuredRecords[0].matchMethod, 'published_exact');
assert.equal(exactRetrieval.evidence[0].recordId, 'record-exact');
assert.equal(exactRetrieval.verifiedPublishedEntitySelection?.verified, true);
assert.deepEqual(exactRetrieval.verifiedPublishedEntitySelection?.requestedRecordIds,
  ['record-exact'], 'Fast-path proof must be emitted only after exact authoritative hydration');

{
  const llmOperations = [];
  let semanticValidationCalls = 0;
  const fastTurn = await runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'deterministic-published-fast-path',
    usageDirection: 'inbound', language: 'en', mainPrompt: 'Use published facts.',
    latestUtterance: 'Alpha Alias', state: {}, assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async (request) => {
      llmOperations.push(request.responseFormat.name);
      assert.ok(request.messages[0].content.includes('"language":"en"'));
      assert.ok(request.messages[0].content.includes('"originalUtterance":"Alpha Alias"'));
      return { decision: 'RESPONSE', response: 'Configured Alpha approved details.',
        clarification: null, evidenceIds: ['E1'], nextQuestion: null,
        stateUpdate: null };
    },
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [],
      publishedConversationGuidance: [], artifacts: exactArtifacts }),
    retrieveEvidence: async ({ searchDecision: selected }) => {
      assert.deepEqual(selected.search.preferredRecordIds, ['record-exact']);
      return exactRetrieval;
    },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => assert.fail('No tool may execute'),
    validateGroundedClaims: async () => {
      semanticValidationCalls += 1;
      return { supported: true, requestedFactAddressed: true };
    },
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(fastTurn.speech, 'Configured Alpha approved details.');
  assert.deepEqual(llmOperations, ['template_engine_post_search_decision'],
    'An exact unique published identity must bypass routing and semantic-review LLM calls');
  assert.equal(semanticValidationCalls, 0,
    'Verified entity, citation, number, relevance and length checks run without an LLM');
}

let ambiguousPublishedReviews = 0;
const ambiguousAliasRecords = ['ambiguous-a', 'ambiguous-b'].map((recordId) => ({
  record_id: recordId, record_type: 'catalog_item', entity_name: recordId,
  entity_aliases: ['Shared Spoken Alias'], entity_metadata: { itemKey: recordId },
}));
const ambiguousRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-ambiguous-alias', usageDirection: 'inbound',
  language: 'en', latestUtterance: 'Shared Spoken Alias details',
  searchDecision: { ...searchDecision, search: { query: 'Shared Spoken Alias details',
    requestedFact: 'details', contextualReference: null, preferredRecordIds: [] } },
  state: {},
  reviewEntityCandidates: async () => { ambiguousPublishedReviews += 1; return null; },
}, {
  loadArtifacts: async () => ({ ...exactArtifacts,
    bundles: [{ ...exactArtifacts.bundles[0], records: ambiguousAliasRecords }],
  }),
  resolveEntityRoute: () => ({ candidate: null, action: 'CLARIFY',
    ambiguity: { detected: true, candidates: ambiguousAliasRecords.map((record) => ({
      recordId: record.record_id, recordType: 'CATALOG_ITEM', label: record.entity_name,
    })) } }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => ({ evidence: selected.candidates.map((entry) => ({
    ...entry, id: entry.recordId, hydrationValidated: true, publicationValidated: true,
    callerFacing: true, content: 'Published detail',
    provenance: { knowledgeBaseId, publicationRevision: 4 },
  })) }),
});
assert.equal(ambiguousPublishedReviews, 1,
  'A shared exact alias must retain the slower multilingual review path');
assert.equal(ambiguousRetrieval.verifiedPublishedEntitySelection, null,
  'Competing published identities must never emit fast-path proof');
assert.equal(ambiguousRetrieval.entityResolution.ambiguity.detected, true);

// Production-shaped metadata must bind hydration even when semantic resolution
// and all retrieval providers prefer conversational evidence.
const metadataRecords = [
  { record_id: 'metadata-alpha', record_type: 'catalog_item', usage_direction: 'both',
    entity_metadata: { name: 'Configured Alpha Service', aliases: ['Alpha Spoken'],
      sttForms: ['Alfa Spoken'], phoneticForms: ['Alfa Form'],
      itemKey: 'metadata-alpha', category: 'Configured Collection',
      categoryKey: 'metadata-collection', price: 17, details: 'Approved alpha detail' } },
  { record_id: 'metadata-beta', record_type: 'catalog_item', usage_direction: 'both',
    entity_metadata: { name: 'Configured Beta Service', itemKey: 'metadata-beta',
      category: 'Configured Collection', categoryKey: 'metadata-collection', price: 29 } },
];
for (const [query, expectedIds, rewrittenQuery] of [
  ['Configured Alpha Service price', ['metadata-alpha']],
  ['Alpha Spoken details', ['metadata-alpha']],
  ['Alfa Spoken details', ['metadata-alpha']],
  ['Alfa Form price', ['metadata-alpha']],
  ['Alpha Spoken details', ['metadata-alpha'], 'Configured Beta Service details'],
  ['Configured Collection details', ['metadata-alpha', 'metadata-beta']],
]) {
  const result = await retrieveTemplateEngineEvidence({
    auth: { tenantId }, scope, callId: 'exact-catalog-regression',
    latestUtterance: query,
    usageDirection: 'inbound', language: 'en',
    searchDecision: { ...searchDecision, search: {
      query: rewrittenQuery || query, requestedFact: query.endsWith('price') ? 'price' : 'details',
      contextualReference: null, preferredRecordIds: [],
    } }, state: {},
  }, {
    loadArtifacts: async () => ({ ...exactArtifacts,
      bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }],
    }),
    resolveEntityRoute: () => ({ candidate: { ...candidate, recordId: 'overview',
      recordType: 'CONVERSATION_NODE' }, candidateNamespace: 'CONVERSATION',
      ambiguity: { detected: false } }),
    searchCandidates: async () => ({ channels: {
      structured: [{ ...candidate, recordId: 'metadata-alpha', matchMethod: 'semantic' }],
      bm25: [{ ...candidate, recordId: 'unrelated-faq', recordType: 'FAQ', score: 1 }],
      qdrant: [{ ...candidate, recordId: 'overview', recordType: 'CONVERSATION_NODE', score: 1 }],
    } }),
    hydrateEvidence: async ({ retrieval: selected }) => {
      assert.deepEqual(selected.candidates.map((entry) => entry.recordId).sort(), expectedIds);
      assert.ok(selected.candidates.every((entry) => entry.recordType === 'CATALOG_ITEM'));
      assert.ok(selected.channels.structured.every((entry) => entry.matchMethod === 'published_exact'),
        'Provider duplicates must not overwrite publication-derived match metadata');
      return { evidence: selected.candidates.map((entry) => ({
        ...entry, id: entry.recordId, hydrationValidated: true, publicationValidated: true,
        callerFacing: true, content: 'Approved published detail',
        authoritativeData: metadataRecords.find((record) => record.record_id === entry.recordId).entity_metadata,
        provenance: { knowledgeBaseId, publicationRevision: 4 },
      })) };
    },
  });
  assert.deepEqual(result.evidence.map((entry) => entry.recordId).sort(), expectedIds);
  assert.equal(result.verifiedPublishedEntitySelection?.verified, true,
    `Exact published identity should emit hydrated fast-path proof: ${query}`);
  assert.deepEqual([...result.verifiedPublishedEntitySelection.requestedRecordIds].sort(), expectedIds);
  assert.ok(result.evidence.every((entry) => entry.requestedFact
    === (query.endsWith('price') ? 'price' : 'details')));
}

for (const language of ['en', 'ta', 'ta-Latn']) {
  for (const scenario of [
    { query: 'Configured Alpha Serviceக்கும் Configured Beta Serviceக்கும் என்ன difference?',
      rewritten: 'Configured Alpha Service details', reference: 'current selection',
      previous: ['metadata-alpha'], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Compare Configured Alpha Service and Configured Beta Service',
      rewritten: 'Configured Alpha Service details', reference: 'current selection',
      previous: ['metadata-alpha'], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Tell me more about this', reference: 'current selection',
      previous: ['metadata-beta'], expected: ['metadata-beta'], comparison: false },
    { query: 'இதை பத்தி கொஞ்சம் detail சொல்லுங்க', reference: 'current selection',
      previous: ['metadata-beta'], expected: ['metadata-beta'], comparison: false },
    { query: 'Compare Configured Alpha Service and Configured Beta Service', reference: null,
      previous: [], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Explain Configured Alpha Service and Configured Beta Service', reference: null,
      previous: [], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Compare their details', reference: 'previous selections',
      previous: ['metadata-alpha', 'metadata-beta'], expected: ['metadata-alpha', 'metadata-beta'], comparison: true },
    { query: 'Configured Beta Service details', reference: 'Configured Beta Service',
      previous: ['metadata-alpha', 'metadata-beta'], expected: ['metadata-beta'], comparison: false },
  ]) {
    const result = await retrieveTemplateEngineEvidence({
      auth: { tenantId }, scope, callId: 'context-comparison-regression', usageDirection: 'inbound', language,
      contextualMemoryVerified: true,
      latestUtterance: scenario.query,
      state: { lastReferencedRecordIds: scenario.previous,
        comparisonRecordIds: scenario.previous.length > 1 ? scenario.previous : [] },
      searchDecision: { ...searchDecision, search: {
        query: scenario.rewritten ?? scenario.query, requestedFact: 'details', contextualReference: scenario.reference,
        preferredRecordIds: [],
      } },
    }, {
      loadArtifacts: async () => ({ ...exactArtifacts,
        bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }],
      }),
      resolveEntityRoute: () => ({ candidate: null, action: 'CLARIFY', ambiguity: {
        detected: true, candidates: metadataRecords.map((record) => ({
          recordId: record.record_id, recordType: 'CATALOG_ITEM', label: record.entity_metadata.name,
        })),
      } }),
      // No provider finds either operand. Published identities must survive.
      searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
      hydrateEvidence: async ({ retrieval: selected, resolution }) => {
        assert.deepEqual(selected.candidates.map((entry) => entry.recordId).sort(), scenario.expected);
        assert.equal(resolution.ambiguity.detected, false);
        return { evidence: selected.candidates.map((entry) => ({
          ...entry, id: entry.recordId, hydrationValidated: true, publicationValidated: true,
          callerFacing: true, content: 'Approved published detail',
          authoritativeData: metadataRecords.find((record) => record.record_id === entry.recordId).entity_metadata,
          provenance: { knowledgeBaseId, publicationRevision: 4 },
        })) };
      },
    });
    assert.deepEqual([...result.requestedEntityRecordIds].sort(), scenario.expected);
    assert.equal(result.searchClassification.searchKind === 'comparison', scenario.comparison);
    assert.equal(publishedResolutionAmbiguity(result.entityResolution, result.evidence,
      result.searchClassification).required, false);
  }
}

let sttSelectedIds = [];
// Generic category vocabulary, not business-name keywords: shared service
// words must not outrank a category-specific published alias.
for (const exact of [false, true]) {
  const categoryRecords = [
    { record_id: 'junior-category', record_type: 'catalog_category', entity_name: 'Junior Screening',
      entity_metadata: { categoryKey: 'screening-youth', aliases: ['junior health packages', 'children health checkup'] } },
    { record_id: 'junior-a', record_type: 'catalog_item', entity_metadata: {
      name: 'Development Screening', category: 'Junior Screening', categoryKey: 'screening-youth' } },
    { record_id: 'junior-b', record_type: 'catalog_item', entity_metadata: {
      name: 'Growth Screening', category: 'Junior Screening', categoryKey: 'screening-youth' } },
    { record_id: 'general-a', record_type: 'catalog_item', entity_metadata: {
      name: 'General Health Checkup', category: 'General Health Checkup', categoryKey: 'general' } },
  ];
  const result = await retrieveTemplateEngineEvidence({
    auth: { tenantId }, scope, callId: 'category-vocabulary', usageDirection: 'inbound', language: 'ta',
    latestUtterance: exact ? 'junior health packages details' : 'junior health checkup details',
    searchDecision: { ...searchDecision, search: { query: 'General Health Checkup',
      requestedFact: 'details', contextualReference: null, preferredRecordIds: [] } },
  }, {
    loadArtifacts: async () => ({ ...exactArtifacts,
      bundles: [{ ...exactArtifacts.bundles[0], records: categoryRecords }] }),
    searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
    hydrateEvidence: async ({ retrieval: selected }) => {
      assert.deepEqual(selected.candidates.map((entry) => entry.recordId).sort(), ['junior-a', 'junior-b']);
      return { evidence: selected.candidates.map((entry) => ({ ...entry, id: entry.recordId,
        hydrationValidated: true, publicationValidated: true, callerFacing: true,
        content: 'Published screening detail', provenance: { knowledgeBaseId, publicationRevision: 4 } })) };
    },
  });
  assert.deepEqual([...result.requestedEntityRecordIds].sort(), ['junior-a', 'junior-b']);
  assert.equal(publishedResolutionAmbiguity(result.entityResolution, result.evidence,
    result.searchClassification).required, !exact, JSON.stringify({ exact, resolution: result.entityResolution, classification: result.searchClassification }));
}
for (const incompleteHydration of [false, true]) {
  const pending = retrieveTemplateEngineEvidence({
    auth: { tenantId }, scope, callId: 'comparison-coverage-guard', usageDirection: 'inbound', language: 'ta',
    latestUtterance: incompleteHydration
      ? 'Configured Alpha Serviceக்கும் Configured Beta Serviceக்கும் difference?'
      : 'Compare Configured Alpha Service and an unknown selection',
    contextualMemoryVerified: true,
    state: { lastReferencedRecordIds: ['metadata-alpha'] },
    searchDecision: { ...searchDecision, search: { query: 'Configured Alpha Service',
      requestedFact: 'difference', contextualReference: 'current selection', preferredRecordIds: ['metadata-alpha'] } },
  }, {
    loadArtifacts: async () => ({ ...exactArtifacts,
      bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }] }),
    searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
    hydrateEvidence: async ({ retrieval: selected }) => ({ evidence: selected.candidates
      .filter((entry) => entry.recordId === 'metadata-alpha').map((entry) => ({
        ...entry, id: entry.recordId, hydrationValidated: true, publicationValidated: true,
        callerFacing: true, content: 'Approved alpha detail',
        authoritativeData: metadataRecords[0].entity_metadata,
        provenance: { knowledgeBaseId, publicationRevision: 4 },
      })) }),
  });
  if (incompleteHydration) {
    await assert.rejects(pending, { code: 'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE' });
  } else {
    const result = await pending;
    assert.equal(publishedResolutionAmbiguity(result.entityResolution, result.evidence,
      result.searchClassification).required, true, 'Unknown operand requires clarification, not a one-record answer');
  }
}
await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'missing-comparison-operand', usageDirection: 'inbound', language: 'en',
  contextualMemoryVerified: true,
  state: { comparisonRecordIds: ['metadata-alpha', 'removed-record'] },
  searchDecision: { ...searchDecision, search: { query: 'Compare their details', requestedFact: 'details',
    contextualReference: 'previous selections', preferredRecordIds: [] } },
}, {
  loadArtifacts: async () => ({ ...exactArtifacts,
    bundles: [{ ...exactArtifacts.bundles[0], records: metadataRecords }],
  }),
}), { code: 'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE' },
'Never silently reduce a remembered comparison to its surviving operand');
const sttVariantRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-stt-variant', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Betacopy', requestedFact: 'details',
      contextualReference: 'Betacopy', preferredRecordIds: ['stale-record'],
    },
  }, state: {},
}, {
  loadArtifacts: async () => ({
    publications: [publication], sparseIndexes: [],
    bundles: [
      { ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] },
      {
        tenantId: '99999999-9999-4999-8999-999999999999', knowledgeBaseId,
        publicationRevision: 4, assignedAgentIds: [agentId], records: [foreignSttVariantRecord],
      },
    ],
  }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    sttSelectedIds = selected.candidates.map((entry) => entry.recordId);
    assert.deepEqual(sttSelectedIds, ['record-stt-variant']);
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-stt-variant', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: sttVariantRecord.content,
      authoritativeData: { name: sttVariantRecord.entity_name, detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.deepEqual(sttSelectedIds, ['record-stt-variant']);
assert.equal(sttVariantRetrieval.evidence[0].recordId, 'record-stt-variant');
assert.equal(sttVariantRetrieval.evidence[0].verified, true);
assert.equal(sttVariantRetrieval.evidence.some((entry) => (
  entry.tenantId !== tenantId || entry.recordId === 'foreign-record-stt-variant'
)), false, 'STT variants must never admit cross-tenant evidence');

let phoneticSelectedIds = [];
const phoneticVariantRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-phonetic-variant', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Beta copy', requestedFact: 'details',
      contextualReference: 'Beta copy', preferredRecordIds: [],
    },
  }, state: {},
}, {
  loadArtifacts: async () => ({
    publications: [publication], sparseIndexes: [],
    bundles: [{ ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] }],
  }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    phoneticSelectedIds = selected.candidates.map((entry) => entry.recordId);
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-phonetic-variant', hydrationValidated: true,
      publicationValidated: true, callerFacing: true, content: sttVariantRecord.content,
      authoritativeData: { name: sttVariantRecord.entity_name, detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.deepEqual(phoneticSelectedIds, ['record-stt-variant']);
assert.equal(phoneticVariantRetrieval.evidence[0].verified, true);

let reviewedVariantSelection = [];
const reviewedVariantRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-reviewed-phonetic-variant', usageDirection: 'inbound',
  language: 'ta', latestUtterance: 'கான்ஃபிகர்ட் பேட்டா விவரம்',
  searchDecision: { ...searchDecision, search: {
    query: 'கான்ஃபிகர்ட் பேட்டா விவரம்', requestedFact: 'details',
    contextualReference: null, preferredRecordIds: ['record-exact'],
  } },
  state: { lastReferencedRecordIds: ['record-exact'], comparisonRecordIds: [] },
  contextualMemoryVerified: false,
  reviewEntityCandidates: async ({ candidates }) => candidates.find(
    (entry) => entry.recordId === 'record-stt-variant',
  ),
}, {
  loadArtifacts: async () => ({ publications: [publication], sparseIndexes: [],
    bundles: [{ ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] }] }),
  resolveEntityRoute: () => ({ candidate: null, action: 'CLARIFY',
    ambiguity: { detected: true, candidates: [] } }),
  searchCandidates: async () => ({ channels: {
    structured: [], bm25: [], qdrant: [],
  } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    reviewedVariantSelection = selected.candidates.map((entry) => entry.recordId);
    assert.deepEqual(reviewedVariantSelection, ['record-stt-variant'],
      'A newly verified multilingual subject must replace an old remembered subject');
    const selectedRecord = selected.candidates[0];
    return { evidence: [{
      ...selectedRecord, id: 'evidence-reviewed-variant', hydrationValidated: true,
      publicationValidated: true, callerFacing: true, content: sttVariantRecord.content,
      authoritativeData: { name: sttVariantRecord.entity_name, detail: 'approved' },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.deepEqual(reviewedVariantSelection, ['record-stt-variant']);
assert.equal(reviewedVariantRetrieval.entityResolution.reason, 'verified_multilingual_identity');
assert.equal(reviewedVariantRetrieval.evidence[0].recordId, 'record-stt-variant');

let unpublishedAliasCandidates = null;
const unpublishedAliasRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-unpublished-alias', usageDirection: 'inbound',
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Explain Betacopi', requestedFact: 'details',
      contextualReference: 'Betacopi', preferredRecordIds: [],
    },
  }, state: {},
}, {
  loadArtifacts: async () => ({
    publications: [publication], sparseIndexes: [],
    bundles: [{ ...exactArtifacts.bundles[0], records: [exactRecord, sttVariantRecord] }],
  }),
  searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    unpublishedAliasCandidates = selected.candidates;
    return { evidence: [], fusion: { candidates: selected.candidates } };
  },
});
assert.deepEqual(unpublishedAliasCandidates, [],
  'An unpublished lookalike must not become an exact alias match');
assert.deepEqual(unpublishedAliasRetrieval.evidence, []);

const guidanceRecord = {
  record_id: 'guidance-overview', record_type: 'conversation_node',
  content: 'Approved overview of Configured Group.', usage_direction: 'both',
  entity_metadata: {
    nodeKey: 'configured_overview', nodeType: 'message',
    purpose: 'Provide the configured overview.',
    catalogReferences: ['Configured Group => category:configured-group'],
  },
};
const guidanceArtifacts = {
  ...exactArtifacts,
  bundles: [{ ...exactArtifacts.bundles[0], records: [guidanceRecord, exactRecord] }],
};
let guidanceSelectedIds = [];
const guidanceRetrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-guidance', usageDirection: 'inbound',
  latestUtterance: 'Yes Madam',
  requestMeaning: { kind: 'published_welcome_continuation', query: 'Show the configured overview' },
  language: 'en', searchDecision: {
    ...searchDecision,
    search: {
      query: 'Show the configured overview', requestedFact: 'available options',
      contextualReference: null, preferredRecordIds: [],
    },
  }, state: {}, conversationGuidance: {
    recordId: 'guidance-overview', knowledgeBaseId, publicationRevision: 4,
    catalogReferences: ['Configured Group => category:configured-group'],
    nextQuestion: 'Which configured option would you like?',
  },
}, {
  loadArtifacts: async () => guidanceArtifacts,
  searchCandidates: async ({ input }) => {
    assert.equal(input.utterance, 'Show the configured overview');
    return { channels: { structured: [], bm25: [], qdrant: [] } };
  },
  hydrateEvidence: async ({ retrieval: selected }) => {
    guidanceSelectedIds = selected.candidates.map((entry) => entry.recordId);
    assert.equal(guidanceSelectedIds.includes('guidance-overview'), true);
    assert.equal(guidanceSelectedIds.includes('record-exact'), true);
    const selectedGuidance = selected.candidates.find((entry) => (
      entry.recordId === 'guidance-overview'
    ));
    return { evidence: [{
      ...selectedGuidance, id: 'evidence-guidance', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: guidanceRecord.content,
      authoritativeData: guidanceRecord.entity_metadata,
      provenance: {
        knowledgeBaseId, publicationRevision: 4, documentId: 'guidance-document',
        uploadedFilename: 'tenant-conversation.txt',
        documentDisplayName: 'Tenant Conversation Guidance', sourceSection: 'Overview',
      },
    }] };
  },
});
assert.equal(guidanceRetrieval.evidence[0].recordId, 'guidance-overview');
assert.equal(guidanceRetrieval.evidence[0].documentId, 'guidance-document');
assert.equal(guidanceRetrieval.evidence[0].documentDisplayName,
  'Tenant Conversation Guidance');

{
  let entityReviews = 0;
  const overviewRetrieval = await retrieveTemplateEngineEvidence({
    auth: { tenantId }, scope, callId: 'call-overview-without-entity-review',
    usageDirection: 'inbound', language: 'en', latestUtterance: 'What is available?',
    searchDecision: { ...searchDecision, search: { query: 'available overview',
      requestedFact: 'overview', contextualReference: null, preferredRecordIds: [] } },
    state: {}, conversationGuidance: { intentClass: 'overview' },
    reviewEntityCandidates: async () => { entityReviews += 1; return null; },
  }, {
    loadArtifacts: async () => ({ publications: [publication], sparseIndexes: [],
      bundles: [{ ...exactArtifacts.bundles[0], records: [exactRecord] }] }),
    resolveEntityRoute: () => ({ candidate: null, action: 'CONTINUE',
      ambiguity: { detected: false, candidates: [] } }),
    searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
    hydrateEvidence: async () => ({ evidence: [], fusion: { candidates: [] } }),
  });
  assert.equal(entityReviews, 0,
    'A clear category overview must not invoke a multilingual entity review');
  assert.equal(overviewRetrieval.searchClassification.searchKind, 'overview');
  assert.equal(overviewRetrieval.diagnostics.identityReviewApplicable, false);
}

let emptyHydrationAttempts = 0;
for (const tenantSuffix of ['a', 'b']) {
  for (const size of [3, 6]) {
    const activeTenant = `${tenantId}-${tenantSuffix}`;
    const records = Array.from({ length: size }, (_, index) => ({
      record_id: `choice-${index}`, record_type: 'catalog_item', usage_direction: 'both',
      entity_name: `Published Choice ${index}`, entity_category: 'Published Collection',
      entity_metadata: { categoryKey: 'published-collection', itemKey: `choice-${index}` },
    }));
    for (const reference of ['Published Collection', 'previous selections']) {
      const hydrationAttempts = [];
      const coverage = await retrieveTemplateEngineEvidence({
        auth: { tenantId: activeTenant }, scope: { ...scope, tenantId: activeTenant },
        callId: 'category-coverage', usageDirection: 'inbound', language: 'ta',
        contextualMemoryVerified: true,
        state: { lastReferencedRecordIds: reference === 'Published Collection'
          ? ['choice-0'] : records.map((record) => record.record_id),
          comparisonRecordIds: reference === 'previous selections' ? records.map((record) => record.record_id) : [] },
        searchDecision: { ...searchDecision, search: { query: 'Explain all of them', requestedFact: 'details',
          contextualReference: reference, preferredRecordIds: [] } },
      }, {
        loadArtifacts: async () => ({ publications: [publication], sparseIndexes: [], bundles: [
          { tenantId: activeTenant, ...publication, records },
          { tenantId: 'foreign-tenant', ...publication, records },
          { tenantId: activeTenant, ...publication, publicationRevision: 3, records },
        ] }),
        resolveEntityRoute: () => ({ candidate: null, ambiguity: { detected: true, candidates: [] } }),
        searchCandidates: async () => ({ channels: { structured: [], bm25: [], qdrant: [] } }),
        hydrateEvidence: async ({ retrieval: selected, resolution, limit, selectionRetry }) => {
          hydrationAttempts.push({ ids: selected.candidates.map((entry) => entry.recordId),
            limit, selectionRetry: selectionRetry === true });
          assert.ok(selected.candidates.length >= 1 && selected.candidates.length <= 5);
          assert.equal(limit, selected.candidates.length);
          assert.ok(limit <= 5, 'Every authoritative RRF request must respect its five-record contract');
          assert.equal(resolution.candidate, null, 'A category wrapper must not filter out its requested children');
          const retained = selectionRetry ? selected.candidates : selected.candidates.slice(0, 1);
          return { evidence: retained.map((entry) => ({ ...entry, id: entry.recordId,
            hydrationValidated: true, publicationValidated: true, callerFacing: true,
            content: 'Published details', authoritativeData: { details: 'Published details' }, provenance: publication,
          })) };
        },
      });
      assert.equal(hydrationAttempts.length, size > 5 ? 4 : 2,
        'Retry every bounded identity batch when the first hydration is incomplete');
      assert.equal(hydrationAttempts.filter((attempt) => attempt.selectionRetry).length,
        size > 5 ? 2 : 1);
      assert.deepEqual(new Set(hydrationAttempts.flatMap((attempt) => attempt.ids)),
        new Set(records.map((record) => record.record_id)));
      assert.equal(coverage.evidence.length, size, 'No top-five truncation of required operands');
      assert.equal(coverage.requestedEntityRecordIds.length, size);
      assert.ok(coverage.evidence.every((entry) => entry.tenantId === activeTenant && entry.publicationRevision === 4));
      assert.equal(publishedResolutionAmbiguity(coverage.entityResolution, coverage.evidence,
        coverage.searchClassification).required, false);
    }
  }
}

await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-empty', usageDirection: 'inbound',
  language: 'en', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => ({
    channels: { structured: [candidate], bm25: [candidate], qdrant: [candidate] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => {
    emptyHydrationAttempts += 1;
    return { evidence: [], fusion: { candidates: selected.candidates }, rejectedRecordIds: [] };
  },
}), { code: 'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE' });
assert.equal(emptyHydrationAttempts, 2,
  'An unresolved published identity must retry hydration exactly once');
const emptyHydration = { evidence: [], diagnostics: { requestedEntityHydrationIncomplete: true } };

const unavailableSpeech = 'That requested information is not currently published.';
const unavailableDecisions = [searchDecision, {
  decision: 'NO_MATCH', response: unavailableSpeech,
  clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
}];
await assert.rejects(() => runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-empty-no-match', usageDirection: 'inbound',
  language: 'en', mainPrompt: 'Use the configured unavailable response when evidence is absent.',
  latestUtterance: 'Tell me the requested published information.',
  conversationHistory: [], state: {}, runtimeProfile: {},
  authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
  informationUnavailableResponse: unavailableSpeech,
}, {
  invokeStructuredLlm: async () => unavailableDecisions.shift(),
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [], publishedConversationGuidance: [], artifacts: {},
  }),
  retrieveEvidence: async () => emptyHydration,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async ({ decision }) => ({
    supported: decision === 'NO_MATCH', successClaimed: false,
    requestedFactAddressed: decision === 'NO_MATCH',
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
}), { code: 'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE' });
assert.equal(unavailableDecisions.length, 1, 'Hydration failure must not reach the answer-generation LLM');

await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-cross-scope', usageDirection: 'inbound',
  language: 'en', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => ({
    channels: { structured: [candidate], bm25: [candidate], qdrant: [] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => ({
    fusion: { candidates: selected.candidates },
    evidence: [{
      ...candidate, tenantId: 'foreign-tenant', id: 'foreign-evidence',
      hydrationValidated: true, publicationValidated: true, callerFacing: true,
      content: 'Foreign content.', provenance: { knowledgeBaseId, publicationRevision: 4 },
    }],
  }),
}), (error) => error.code === 'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_VIOLATION'
  || error.code === 'TEMPLATE_ENGINE_HYDRATION_SCOPE_VIOLATION'
  || error.code === 'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE');

const decisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
}];
for (const scenario of [
  { text: 'No, I meant a different offering', relation: 'new_request' },
  { text: 'இல்ல, வேற checkup பத்தி கேட்டேன்', relation: 'new_request' },
  { text: 'vera option pathi sollunga', relation: 'unclear' },
  { text: 'Tell me more about this', relation: 'reference' },
  { text: 'Compare those two again', relation: 'reference' },
  { text: 'No, the price of this one', relation: 'reference' },
]) {
  const previousState = { recentCompleteTurns: [
    { role: 'user', content: 'Tell me about Tenant Item' },
    { role: 'assistant', content: 'Tenant Item has published details.' },
  ], lastReferencedRecordIds: ['record-1'], comparisonRecordIds: [] };
  const originalState = JSON.stringify(previousState);
  let calls = 0;
  await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Use only published information.', latestUtterance: scenario.text,
    conversationHistory: previousState.recentCompleteTurns,
    state: previousState, assignedTools: [], informationFields: [],
  }, {
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
    invokeStructuredLlm: async (request) => {
      assert.notEqual(request.responseFormat.name, 'template_engine_reference_review',
        'Context verification must be deferred to the retrieval resolver');
      calls += 1;
      return calls === 1 ? { ...searchDecision, search: {
        query: 'Tenant Item price', requestedFact: 'price',
        contextualReference: 'Tenant Item', preferredRecordIds: ['record-1'],
      } } : { decision: 'RESPONSE', response: 'Tenant Item costs 125.',
        clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null };
    },
    retrieveEvidence: async (request) => {
      const reuse = scenario.relation === 'reference';
      assert.equal(request.contextualMemoryVerified, false);
      assert.equal(request.contextualMemoryCandidate, true);
      assert.deepEqual(request.searchDecision.search.preferredRecordIds, ['record-1']);
      assert.deepEqual(request.state.lastReferencedRecordIds, ['record-1']);
      return { ...retrieval, contextualMemoryVerified: reuse,
        resolvedSearch: reuse ? request.searchDecision.search : {
          ...request.searchDecision.search, query: scenario.text,
          contextualReference: null, preferredRecordIds: [],
        } };
    },
    persistWorkflowState: async () => assert.fail('Search must not persist a workflow'),
    executeAuthorizedTool: async () => assert.fail('Search must not execute tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(JSON.stringify(previousState), originalState, 'Review must not mutate call memory');
}
{
  const confirmedDecisions = [{ ...searchDecision, search: {
    query: 'Tenant Item price', requestedFact: 'price',
    contextualReference: 'Tenant Item', preferredRecordIds: ['record-1'],
  } }, { decision: 'RESPONSE', response: 'Tenant Item costs 125.',
    clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null }];
  let diagnostics = null;
  const result = await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Use only published information.',
    latestUtterance: 'What is its price?', assignedTools: [], informationFields: [],
    state: { lastReferencedRecordIds: ['record-1'], comparisonRecordIds: [],
      pendingClarification: { candidates: ['Tenant Item'] } },
  }, {
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
    invokeStructuredLlm: async (request) => {
      assert.notEqual(request.responseFormat.name, 'template_engine_reference_review',
        'A confirmed exact reference must not invoke another reference reviewer');
      return confirmedDecisions.shift();
    },
    retrieveEvidence: async (request) => {
      assert.equal(request.contextualMemoryVerified, true);
      assert.equal(request.contextualMemoryCandidate, true);
      assert.deepEqual(request.searchDecision.search.preferredRecordIds, ['record-1']);
      return retrieval;
    },
    persistWorkflowState: async () => assert.fail('Search must not persist a workflow'),
    executeAuthorizedTool: async () => assert.fail('Search must not execute tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
    onRetrievalDiagnostics: (value) => { diagnostics = value; },
  });
  assert.equal(result.speech, 'Tenant Item costs 125.');
  assert.equal(confirmedDecisions.length, 0);
  assert.equal(diagnostics.confirmedContextualReferenceFastPath, true);
}
const referenceInput = { latestUtterance: 'More details?',
  search: { preferredRecordIds: ['record-1'], contextualReference: 'Tenant Item' },
  state: { recentCompleteTurns: [{ role: 'assistant', content: 'Tenant Item details' }] } };
assert.equal(await reviewRememberedReference(referenceInput, async () => ({ relation: 'invalid' })), false);
{
  let calls = 0;
  let coverageChecks = 0;
  const result = await runTemplateEngineProductionTurn({ scope, latestUtterance: 'Yes Madam',
    mainPrompt: 'Follow published steps.', assignedTools: [], informationFields: [],
    acknowledgementPhrases: ['Yes Madam'],
    pendingQuestion: { key: 'configured_welcome_question', text: 'Is this the account holder?' },
  }, {
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Welcome is not tool consent'); },
    validateToolResultSpeechClaims: async () => ({ supported: true }),
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {},
      publishedConversationGuidance: [{ recordId: 'next-step', recordType: 'CONVERSATION_NODE', published: true,
        tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
        purpose: 'After acceptance explain the available services.', response: 'Explain available services.',
        nextQuestion: null }] }),
    invokeStructuredLlm: async (request) => {
      assert.notEqual(request.responseFormat.name, 'template_engine_orchestrator_decision',
        'An exact configured acknowledgement with one published next step must skip routing');
      assert.notEqual(request.responseFormat.name, 'template_engine_welcome_meaning',
        'A deterministic published continuation must not need a meaning-review LLM call');
      calls += 1;
      assert.ok(request.messages[0].content.includes('published_welcome_continuation'));
      return { decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
        evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null };
    },
    retrieveEvidence: async (input) => {
      assert.equal(input.latestUtterance, 'Yes Madam');
      assert.match(input.searchDecision.search.query, /available services/u);
      assert.equal(input.requestMeaning.pendingWelcomeQuestion.text, 'Is this the account holder?');
      return retrieval;
    },
    validateRequestedEntityCoverage: async (input) => {
      coverageChecks += 1;
      assert.equal(input.requestMeaning.publishedNextStep.recordId, 'next-step');
      assert.equal(input.latestUtterance, 'Yes Madam');
      return { resolved: true };
    },
    validateGroundedClaims: async (input) => {
      assert.equal(input.requestMeaning.kind, 'published_welcome_continuation');
      return { supported: true, requestedFactAddressed: true };
    },
  });
  assert.equal(result.decision.decision, 'RESPONSE');
  assert.equal(result.toolExecuted, false);
  assert.equal(calls, 1, 'Only grounded answer generation is needed after deterministic continuation');
  assert.equal(coverageChecks, 0,
    'Resolved retrieval must rely on the complete post-answer grounding check instead of a duplicate entity review');
}
assert.equal(await reviewRememberedReference(referenceInput, async () => 'not json'), false);
await assert.rejects(() => reviewRememberedReference(referenceInput, async () => {
  throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
}), { name: 'AbortError' });
for (const latestUtterance of ['ஆமா Madam', 'Yes, speaking', 'No thanks',
  'Wrong person', 'Stop calling', 'Tell me the price instead']) {
  let calls = 0;
  const welcomeTurn = await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Follow published conversation guidance.', latestUtterance,
    pendingQuestion: { key: 'configured_welcome_question', text: 'Is this the account holder?' },
    assignedTools: [], informationFields: [],
  }, {
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {},
      publishedConversationGuidance: [{
        recordId: 'welcome-guidance', recordType: 'CONVERSATION_NODE', published: true,
        tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
        purpose: 'After acceptance, explain available account services.',
        situation: 'Reply to the introduction', content: 'Follow the configured service overview.',
        examples: ['Yes, speaking'], catalogReferences: [], language: 'en',
      }],
    }),
    invokeStructuredLlm: async (request) => {
      calls += 1;
      assert.ok(request.messages[0].content.includes('Is this the account holder?'));
      assert.ok(request.messages[0].content.includes('explain available account services'));
      assert.equal(request.messages.at(-1).content, latestUtterance);
      return { decision: 'RESPONSE', response: 'Understood.', clarification: null,
        search: null, tool: null, nextQuestion: null, stateUpdate: null };
    },
    retrieveEvidence: async () => { throw new Error('Must not force search from welcome context'); },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Must not force tool activation'); },
    validateGroundedClaims: async () => ({ supported: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(welcomeTurn.speech, 'Understood.');
  assert.equal(calls, 1, 'Welcome context must not add an LLM round-trip');
}
let retrievalDiagnostics;
let postSearchDiagnostics;
const turn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-1', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Answer in English. Search for factual requests.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => decisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
  retrieveEvidence: async () => retrieval,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onRetrievalDiagnostics: (details) => { retrievalDiagnostics = details; },
  onPostSearchDiagnostics: (details) => { postSearchDiagnostics = details; },
});
assert.equal(turn.speech, 'Tenant Item costs 125.');
assert.deepEqual(turn.evidenceIds, ['evidence-1']);
assert.deepEqual(turn.state.lastReferencedRecordIds, ['record-1']);
assert.equal(decisions.length, 0);
assert.equal(retrievalDiagnostics.retrievalCount, 1);
assert.deepEqual(postSearchDiagnostics.allowedAliases, ['E1']);
assert.deepEqual(postSearchDiagnostics.returnedAliases, ['E1']);
assert.equal(postSearchDiagnostics.finalDecision, 'RESPONSE');
assert.equal(turn.provenance.initialDecision, 'SEARCH');
assert.equal(turn.provenance.finalDecision, 'RESPONSE');
assert.deepEqual(turn.provenance.evidenceIds, ['evidence-1']);
assert.equal(turn.provenance.searchPerformed, true);

let speculativeStarted = false;
let routedWhileSpeculativeActive = false;
let ordinaryRetrievalCalls = 0;
let speculativeDiagnostics;
let deterministicChecks = 0;
const speculativeDecisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: {
    question: 'Would you like another published detail?', reason: 'guidance',
  }, stateUpdate: null,
}];
const speculativeTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-speculative', usageDirection: 'inbound', language: 'en',
  speculativeRetrievalAuthorized: true,
  mainPrompt: 'Answer in English. Search for factual requests.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => {
    routedWhileSpeculativeActive ||= speculativeStarted;
    return speculativeDecisions.shift();
  },
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [], artifacts: {},
    publishedConversationGuidance: [{
      recordId: 'guidance-1', purpose: 'Continue relevant assistance',
      nextQuestion: 'Would you like another published detail?',
    }],
  }),
  retrieveSpeculativeEvidence: async () => {
    speculativeStarted = true;
    return retrieval;
  },
  retrieveEvidence: async () => {
    ordinaryRetrievalCalls += 1;
    return retrieval;
  },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => {
    deterministicChecks += 1;
    return { supported: true, successClaimed: false, requestedFactAddressed: true };
  },
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onRetrievalDiagnostics: (details) => { speculativeDiagnostics = details; },
});
assert.equal(routedWhileSpeculativeActive, true,
  'Routing must run while speculative hybrid retrieval is already active');
assert.equal(ordinaryRetrievalCalls, 0,
  'A compatible speculative result must avoid duplicate retrieval');
assert.equal(speculativeDiagnostics.speculativeReused, true);
assert.equal(deterministicChecks, 1,
  'Follow-up validation must not add a second grounding-validator call');
assert.match(speculativeTurn.speech, /Tenant Item costs 125/u);

{
  let foregroundRetrievals = 0;
  const decisions = [searchDecision, {
    decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
    evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
  }];
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'bounded-speculative-handoff',
    speculativeRetrievalAuthorized: true,
    usageDirection: 'inbound', language: 'en', mainPrompt: 'Use published facts.',
    latestUtterance: 'What is the tenant item price?', state: {}, assignedTools: [],
    informationFields: [],
  }, {
    invokeStructuredLlm: async () => decisions.shift(),
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
    retrieveSpeculativeEvidence: async () => new Promise((resolve) => {
      setTimeout(() => resolve(retrieval), 5);
    }),
    retrieveEvidence: async () => { foregroundRetrievals += 1; return retrieval; },
    speculativeRetrievalHandoffMs: 25,
    persistWorkflowState: async () => {}, executeAuthorizedTool: async () => assert.fail('No tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(result.speech, 'Tenant Item costs 125.');
  assert.equal(foregroundRetrievals, 0,
    'A routing-compatible speculative result finishing inside the bounded handoff must be reused');
}

{
  let foregroundRetrievals = 0;
  const decisions = [searchDecision, {
    decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
    evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
  }];
  const wrongRevision = { ...retrieval,
    scope: { ...retrieval.scope, publications: retrieval.scope.publications.map((entry) => ({
      ...entry, publicationRevision: Number(entry.publicationRevision) + 1,
    })) } };
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'revision-isolated-speculation',
    speculativeRetrievalAuthorized: true,
    usageDirection: 'inbound', language: 'en', mainPrompt: 'Use published facts.',
    latestUtterance: 'What is the tenant item price?', state: {}, assignedTools: [],
    informationFields: [],
  }, {
    invokeStructuredLlm: async () => decisions.shift(),
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
    retrieveSpeculativeEvidence: async () => wrongRevision,
    retrieveEvidence: async () => { foregroundRetrievals += 1; return retrieval; },
    persistWorkflowState: async () => {}, executeAuthorizedTool: async () => assert.fail('No tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(result.speech, 'Tenant Item costs 125.');
  assert.equal(foregroundRetrievals, 1,
    'Speculative evidence from another publication revision must never be reused');
}

const exactSpeculativeRetrieval = Object.freeze({
  ...retrieval,
  search: searchDecision.search,
  resolvedSearch: searchDecision.search,
  requestedEntityRecordIds: Object.freeze(['record-1']),
  entityResolution: Object.freeze({
    action: 'CONTINUE', reason: 'published_exact_selection',
    requiresCandidateConfirmation: false,
    ambiguity: Object.freeze({ detected: false, candidates: Object.freeze([]) }),
  }),
  diagnostics: Object.freeze({ requestedEntityHydrationIncomplete: false }),
  verifiedPublishedEntitySelection: Object.freeze({
    verified: true, matchMethod: 'published_exact',
    knowledgeBaseId, publicationRevision: 4,
    requestedRecordIds: Object.freeze(['record-1']),
  }),
});
assert.equal(verifiedPublishedEntityFastPath(exactSpeculativeRetrieval, searchDecision, {
  latestUtterance: 'tenant item price',
}), true);
assert.equal(verifiedPublishedEntityFastPath({ ...exactSpeculativeRetrieval,
  entityResolution: { ...exactSpeculativeRetrieval.entityResolution,
    requiresCandidateConfirmation: true },
}, searchDecision, { latestUtterance: 'tenant item price' }), false,
'Confirmation candidates must retain the existing clarification path');
assert.equal(verifiedPublishedEntityFastPath({ ...exactSpeculativeRetrieval,
  verifiedPublishedEntitySelection: null,
}, searchDecision, { latestUtterance: 'tenant item price' }), false,
'A reason label without hydrated published-selection proof must not activate the fast path');
assert.equal(verifiedPublishedEntityFastPath({ ...exactSpeculativeRetrieval,
  verifiedPublishedEntitySelection: { ...exactSpeculativeRetrieval.verifiedPublishedEntitySelection,
    requestedRecordIds: ['another-record'] },
}, searchDecision, { latestUtterance: 'tenant item price' }), false,
'Fast-path selection IDs must exactly match the hydrated requested IDs');
{
  let referenceReviews = 0;
  let foregroundRetrievals = 0;
  let fastPathDiagnostics = null;
  const factualLlmOperations = [];
  const fastPathDecisions = [{ ...searchDecision, search: {
    ...searchDecision.search, contextualReference: 'Old Item', preferredRecordIds: ['old-record'],
  } }, { decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
    evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null }];
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'exact-fast-path', usageDirection: 'inbound', language: 'en',
    speculativeRetrievalAuthorized: true,
    mainPrompt: 'Use published facts.', latestUtterance: 'tenant item price',
    conversationHistory: [{ role: 'user', content: 'Old Item details' },
      { role: 'assistant', content: 'Old Item details.' }],
    state: { lastReferencedRecordIds: ['old-record'] }, assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async (request) => {
      if (request.responseFormat.name === 'template_engine_reference_review') {
        referenceReviews += 1;
        return { relation: 'new_request' };
      }
      factualLlmOperations.push(request.responseFormat.name);
      return fastPathDecisions.shift();
    },
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
    retrieveSpeculativeEvidence: async () => exactSpeculativeRetrieval,
    retrieveEvidence: async () => { foregroundRetrievals += 1; return exactSpeculativeRetrieval; },
    persistWorkflowState: async () => {}, executeAuthorizedTool: async () => assert.fail('No tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
    onRetrievalDiagnostics: (details) => { fastPathDiagnostics = details; },
  });
  assert.equal(result.speech, 'Tenant Item costs 125.');
  assert.equal(referenceReviews, 0,
    'Exact current published identity must bypass the stale remembered-reference review');
  assert.deepEqual(factualLlmOperations, [
    'template_engine_orchestrator_decision', 'template_engine_post_search_decision',
  ], 'A clear verified factual request must use one routing call and one answer call');
  assert.equal(foregroundRetrievals, 0, 'Verified exact speculative evidence must be reused');
  assert.equal(fastPathDiagnostics.highConfidenceFastPath, true);
}
{
  let welcomeMeaningReviews = 0;
  const decisions = [searchDecision, { decision: 'RESPONSE', response: 'Tenant Item costs 125.',
    clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null }];
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'exact-fast-path-with-pending-welcome',
    speculativeRetrievalAuthorized: true,
    usageDirection: 'inbound', language: 'en', mainPrompt: 'Use published facts.',
    latestUtterance: 'tenant item price',
    pendingQuestion: { key: 'configured_welcome_question', text: 'May I continue?' },
    state: {}, assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async (request) => {
      if (request.responseFormat.name === 'template_engine_welcome_meaning') {
        welcomeMeaningReviews += 1;
        return { outputParsed: { continuation: false, guidanceRecordId: null,
          query: null, requestedFact: null } };
      }
      return decisions.shift();
    },
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {},
      publishedConversationGuidance: [{ recordId: 'welcome-only', recordType: 'CONVERSATION_NODE',
        published: true, tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
        purpose: 'Continue after an affirmative introduction response.', situation: 'Introduction',
        examples: ['Yes'], catalogReferences: [], nodeKey: 'welcome_continuation',
        intentClass: null, context: null, nextQuestion: null }],
    }),
    retrieveSpeculativeEvidence: async () => exactSpeculativeRetrieval,
    retrieveEvidence: async () => exactSpeculativeRetrieval,
    persistWorkflowState: async () => {}, executeAuthorizedTool: async () => assert.fail('No tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(result.speech, 'Tenant Item costs 125.');
  assert.equal(welcomeMeaningReviews, 0,
    'A hydrated exact entity request must not pay for a pending-welcome meaning review');
}
{
  let foregroundRetrievals = 0;
  await assert.rejects(() => runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'cancelled-speculative-turn', turnEpoch: 11,
    speculativeRetrievalAuthorized: true,
    turnBoundaryId: 'cancelled-speculative-turn:11', usageDirection: 'inbound', language: 'en',
    mainPrompt: 'Use published facts.', latestUtterance: 'tenant item price',
    state: {}, assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async () => searchDecision,
    isTurnCurrent: () => false,
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
    retrieveSpeculativeEvidence: async () => exactSpeculativeRetrieval,
    retrieveEvidence: async () => { foregroundRetrievals += 1; return exactSpeculativeRetrieval; },
    persistWorkflowState: async () => {}, executeAuthorizedTool: async () => assert.fail('No tools'),
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  }), { name: 'AbortError' });
  assert.equal(foregroundRetrievals, 0,
    'A cancelled epoch must consume neither speculative nor foreground retrieval');
}

let releaseSpeculation;
const delayedSpeculation = new Promise((resolve) => { releaseSpeculation = resolve; });
const loadedArtifacts = {};
let publicationLoads = 0;
let foregroundRetrievals = 0;
const foregroundStages = [];
const foregroundDecisions = [searchDecision, { decision: 'RESPONSE', response: 'Tenant Item costs 125.',
  clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null }];
let deadline;
try {
  const foreground = runTemplateEngineProductionTurn({
    auth: { tenantId }, scope, callId: 'slow-speculation', usageDirection: 'inbound', language: 'en',
    speculativeRetrievalAuthorized: true,
    mainPrompt: 'Use published facts.', latestUtterance: 'What is the tenant item price?', state: {},
    assignedTools: [], informationFields: [],
  }, {
    invokeStructuredLlm: async () => foregroundDecisions.shift(),
    loadPublishedContext: async () => { publicationLoads += 1;
      return { scope, artifacts: loadedArtifacts, publishedWorkflows: [] }; },
    retrieveSpeculativeEvidence: async ({ preloadedArtifacts }) => {
      assert.equal(preloadedArtifacts, loadedArtifacts);
      return delayedSpeculation;
    },
    retrieveEvidence: async ({ preloadedArtifacts }) => {
      foregroundRetrievals += 1;
      assert.equal(preloadedArtifacts, loadedArtifacts, 'Foreground and speculation share the exact per-turn publication snapshot');
      return retrieval;
    },
    persistWorkflowState: async () => {}, executeAuthorizedTool: async () => { assert.fail('No tools'); },
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
    onStageTiming: (event) => foregroundStages.push(event.stage),
  });
  const result = await Promise.race([foreground, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('Foreground waited for unfinished speculation')), 2000);
  })]);
  assert.equal(result.speech, 'Tenant Item costs 125.');
  assert.equal(publicationLoads, 1);
  assert.equal(foregroundRetrievals, 1);
  for (const stage of ['publication_load', 'routing', 'retrieval', 'generation']) {
    assert.ok(foregroundStages.includes(stage), `Missing timing for ${stage}`);
  }
  assert.equal(foregroundStages.includes('validation'), false,
    'Deterministically grounded normal answers must not invoke semantic validation');
} finally {
  clearTimeout(deadline);
  releaseSpeculation(retrieval);
}

const guardedDecisions = [{
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  search: null, tool: null, nextQuestion: null, stateUpdate: null,
}, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
}];
let guardedClaimChecks = 0;
let guardedRetrievalCalls = 0;
const guardedTimingOperations = [];
const guardedTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-guarded', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use RESPONSE only for non-factual speech and SEARCH for facts.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => guardedDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
  retrieveEvidence: async () => {
    guardedRetrievalCalls += 1;
    return retrieval;
  },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => {
    guardedClaimChecks += 1;
    return {
      supported: guardedClaimChecks > 1,
      successClaimed: false,
      requestedFactAddressed: guardedClaimChecks > 1,
    };
  },
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onStageTiming: (event) => guardedTimingOperations.push(event.operation),
});
assert.equal(guardedRetrievalCalls, 1,
  'A rejected factual direct RESPONSE must search the unchanged caller request');
assert.equal(guardedTurn.decision.decision, 'RESPONSE');
assert.deepEqual(guardedTurn.evidenceIds, ['evidence-1']);
assert.equal(guardedDecisions.length, 0);
assert.equal(guardedTimingOperations.filter((operation) => operation === 'initial_routing').length, 1);
assert.equal(guardedTimingOperations.filter((operation) => operation === 'grounding_reroute').length, 0,
  'Rejected uncited speech must not trigger a duplicate routing LLM call');

const tool = {
  id: 'tool-1', name: 'perform_action', status: 'active', type: 'webhook_api',
  configuration: {
    identifier: 'perform_action',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { contact_name: { type: 'string', minLength: 1 } },
      required: ['contact_name'],
      'x-confirmation-message': 'Confirm these details?',
    },
  },
};
const workflow = {
  recordId: 'workflow-1', recordType: 'WORKFLOW_RULE', tenantId, agentId,
  knowledgeBaseId, publicationRevision: 4, published: true, status: 'published',
  actionType: 'configured_tool', actionConfig: { toolIdentifier: 'perform_action' },
};
const workflowDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} }, nextQuestion: null, stateUpdate: null,
}, { speech: 'Please provide the configured contact name.' }];
// Wrong initial TOOL decisions must be corrected before missing-field preflight.
for (const scenario of [
  { utterance: 'Why did you call?', route: 'SEARCH' },
  { utterance: 'எதுக்கு Madam phone பண்ணீங்க?', route: 'SEARCH' },
  { utterance: 'Why phone panneenga?', route: 'SEARCH' },
  { utterance: 'Can this service be requested online?', route: 'SEARCH' },
  { utterance: 'Maybe that one, I am not sure what to do', route: 'CLARIFY' },
  { utterance: 'That thing, maybe?', route: 'CLARIFY', directClarification: true },
  { utterance: 'No thanks, wrong person', route: 'RESPONSE' },
]) {
  let calls = 0;
  let searches = 0;
  let writes = 0;
  const reviewed = scenario.route === 'SEARCH' ? searchDecision : {
    decision: scenario.route, response: scenario.route === 'RESPONSE' ? 'Understood.' : '',
    clarification: scenario.route === 'CLARIFY'
      ? { question: 'What would you like me to do?', reason: 'unclear action intent', candidates: [] } : null,
    search: null, tool: null, nextQuestion: null, stateUpdate: null,
  };
  const result = await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Follow the published service configuration.',
    latestUtterance: scenario.utterance, assignedTools: [tool], informationFields: [],
  }, {
    invokeStructuredLlm: async (request) => {
      calls += 1;
      if (calls === 1) return scenario.directClarification ? reviewed : structuredClone(workflowDecisions[0]);
      if (calls === 2) {
        assert.match(request.messages.at(-1).content, /TOOL_ACTIVATION_REVIEW/u);
        assert.ok(request.messages.some((message) => message.role === 'user'
          && message.content === scenario.utterance));
        return reviewed;
      }
      return { decision: 'RESPONSE', response: 'Tenant Item costs 125.',
        clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null };
    },
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
    retrieveEvidence: async () => { searches += 1; return retrieval; },
    persistWorkflowState: async () => { writes += 1; },
    executeAuthorizedTool: async () => { throw new Error('Informational or unclear intent must not execute'); },
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(writes, 0);
  assert.equal(result.state.activeWorkflowId, null);
  assert.equal(searches, scenario.route === 'SEARCH' ? 1 : 0);
  assert.equal(calls, scenario.directClarification ? 1 : scenario.route === 'SEARCH' ? 3 : 2);
}
workflowDecisions.splice(1, 0, structuredClone(workflowDecisions[0]));
const workflowTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-2', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Please perform the action for this option.', conversationHistory: [],
  state: { lastReferencedRecordIds: ['selected-option'] },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async (request) => {
    if (request.messages.some((message) => message.content.includes('TOOL_ACTIVATION_REVIEW:'))) {
      assert.deepEqual(request.responseFormat.schema.properties.stateUpdate, { type: 'null' },
        'New activation review cannot clear workflow state or manufacture confirmation');
    }
    return workflowDecisions.shift();
  },
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('incomplete workflow must not execute'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(workflowTurn.workflow.status, 'AWAITING_FIELD');
assert.equal(workflowTurn.state.activeWorkflowId, 'workflow-1');
assert.deepEqual(workflowTurn.state.lastReferencedRecordIds, ['selected-option'],
  'Entering field collection must preserve the selected subject without executing');
assert.equal(workflowTurn.toolExecuted, false);
assert.equal(workflowTurn.provenance.initialDecision, 'TOOL');
assert.equal(workflowTurn.provenance.finalDecision, 'CLARIFY');
assert.equal(workflowTurn.provenance.workflowId, 'workflow-1');
assert.equal(workflowTurn.provenance.toolId, 'tool-1');
assert.equal(workflowTurn.provenance.clarificationReason, 'missing_workflow_field');
assert.equal(workflowDecisions.length, 0);

// Reproduce the live failure: a conversational acknowledgement must not bypass
// field persistence, and subsequent answers must not restart collection.
const collectionTool = structuredClone(tool);
collectionTool.configuration.inputSchema.properties = {
  recipient: { type: 'string' }, contact_name: { type: 'string' },
  age: { type: 'number' }, requested_date: { type: 'string' },
};
collectionTool.configuration.inputSchema.required = ['recipient', 'contact_name', 'age', 'requested_date'];
const collectionFields = [
  ['recipient', 'யாருக்காக?', 'text'], ['contact_name', 'பெயர் என்ன?', 'text'],
  ['age', 'வயசு என்ன?', 'number'], ['requested_date', 'எந்த தேதி?', 'text'],
].map(([key, question, type]) => ({ key, label: key, type, question, required: true, requiredAction: tool.name }));
const collectionResponse = (response) => ({ decision: 'RESPONSE', response,
  clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null });
const collectionDecision = (args) => ({ decision: 'TOOL', response: '',
  clarification: null, search: null, tool: { name: tool.name, arguments: JSON.stringify(args) },
  nextQuestion: null, stateUpdate: null });
let scalarRoutingCalls = 0;
const scalarCollectionTurn = await runTemplateEngineProductionTurn({
  scope, mainPrompt: 'Use configured questions, one field at a time.',
  latestUtterance: '21', language: 'en',
  state: { activeWorkflowId: workflow.recordId,
    collectedToolFields: { recipient: 'self', contact_name: 'Shanmugam' },
    confirmationStatus: 'pending_fields', lastReferencedRecordIds: ['selected-option'] },
  assignedTools: [collectionTool], informationFields: collectionFields,
}, {
  invokeStructuredLlm: async (request) => {
    if (request.responseFormat.name === 'template_engine_orchestrator_decision') {
      scalarRoutingCalls += 1;
      assert.fail('An exact configured numeric field answer must not repeat routing');
    }
    return { output: JSON.stringify({ speech: collectionFields
      .find((field) => field.key === 'requested_date').question }) };
  },
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('Field replies must not search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('Unconfirmed collection must not execute'); },
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  validateToolResultSpeechClaims: async () => ({ supported: true }),
});
assert.equal(scalarRoutingCalls, 0);
assert.equal(scalarCollectionTurn.state.collectedToolFields.age, 21);
assert.equal(scalarCollectionTurn.workflow.status, 'AWAITING_FIELD');
assert.equal(scalarCollectionTurn.workflow.speechTask.field.key, 'requested_date');
assert.equal(scalarCollectionTurn.toolExecuted, false);
let collectionState = { activeWorkflowId: workflow.recordId, collectedToolFields: {},
  confirmationStatus: 'pending_fields', lastReferencedRecordIds: ['selected-option'] };
let bookingSpeculativeCalls = 0;
async function replayCollection(utterance, initial, reviewed, expectedField) {
  const outputs = [initial, ...(reviewed ? (Array.isArray(reviewed) ? reviewed : [reviewed]) : []),
    ...(expectedField ? [{ speech: collectionFields.find((field) => field.key === expectedField).question }] : [])];
  const result = await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Use configured questions, one field at a time.',
    latestUtterance: utterance, language: 'ta', state: collectionState,
    assignedTools: [collectionTool], informationFields: collectionFields,
  }, {
    invokeStructuredLlm: async (request) => {
      if (request.responseFormat.name === 'template_engine_orchestrator_decision') {
        assert.match(request.messages[0].content, /workflowCollection/u);
        assert.match(request.messages[0].content, /pendingFieldKey/u);
      }
      return { output: JSON.stringify(outputs.shift()) };
    },
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
    retrieveEvidence: async () => { throw new Error('Field replies must not search'); },
    retrieveSpeculativeEvidence: async () => { bookingSpeculativeCalls += 1; return retrieval; },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Unconfirmed collection must not execute'); },
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(outputs.length, 0);
  assert.equal(result.toolExecuted, false);
  if (expectedField) {
    assert.equal(result.workflow.speechTask.field.key, expectedField);
    assert.equal((result.speech.match(/\?/gu) ?? []).length, 1);
  }
  collectionState = result.state;
  return result;
}
const unclearField = await replayCollection('ஐ மன்னிக்க தான் மனோ', collectionDecision({}), [collectionDecision({}), {
  decision: 'CLARIFY', response: '', tool: null, search: null, nextQuestion: null, stateUpdate: null,
  clarification: { question: 'யாருக்காக கேட்கிறீர்கள் என்று தெளிவாகச் சொல்ல முடியுமா?',
    reason: 'Unclear reply to the pending field', candidates: [] },
}]);
assert.equal(unclearField.decision.decision, 'CLARIFY');
assert.deepEqual(collectionState.collectedToolFields, {});
await replayCollection('எனக்குத்தான் madam',
  collectionResponse('Understood. What is your name, age and date?'),
  collectionDecision({ recipient: 'எனக்குத்தான்' }), 'contact_name');
assert.equal(collectionState.collectedToolFields.recipient, 'எனக்குத்தான்');
await replayCollection('எனக்குத்தான் madam', collectionDecision({ recipient: 'self' }),
  collectionDecision({ recipient: 'எனக்குத்தான்' }), 'contact_name');
assert.equal(collectionState.collectedToolFields.recipient, 'எனக்குத்தான்',
  'Translation must not be silently dropped and restart the already answered field');
await replayCollection('என்னோட name சண்முகம் வயசு 21',
  collectionDecision({ contact_name: 'சண்முகம்', age: 21 }), null, 'requested_date');
assert.deepEqual(collectionState.collectedToolFields,
  { recipient: 'எனக்குத்தான்', contact_name: 'சண்முகம்', age: 21 });
await replayCollection('Correction: name is Arun', collectionDecision({ contact_name: 'Arun' }), null, 'requested_date');
assert.equal(collectionState.collectedToolFields.contact_name, 'Arun');
assert.equal(collectionState.collectedToolFields.recipient, 'எனக்குத்தான்');
const beforeSideQuestion = structuredClone(collectionState.collectedToolFields);
await replayCollection('Can you speak more slowly?', collectionResponse('Of course.'), collectionResponse('Of course.'));
assert.deepEqual(collectionState.collectedToolFields, beforeSideQuestion);
assert.equal(collectionState.activeWorkflowId, workflow.recordId);
// A misrouted stop request must be reviewed before another field is spoken.
await replayCollection('cut பண்ணுங்க madam', collectionDecision({}), {
  ...collectionResponse('சரி, நிறுத்துகிறேன்.'),
  stateUpdate: { set: { confirmationStatus: null },
    clear: ['activeWorkflowId', 'collectedToolFields', 'confirmationStatus'] },
});
assert.equal(collectionState.activeWorkflowId, null);
assert.deepEqual(collectionState.collectedToolFields, {});

const contextualWorkflowDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: { contact_name: 'Sam' } },
  nextQuestion: null,
  stateUpdate: null,
}, { speech: 'Please confirm the collected value Sam.' }];
contextualWorkflowDecisions.splice(1, 0, structuredClone(contextualWorkflowDecisions[0]));
const contextualWorkflowTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-contextual-tool',
  usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Please perform it.',
  conversationHistory: [
    { role: 'user', content: 'The configured contact name is Sam.' },
    { role: 'assistant', content: 'I have that value.' },
  ],
  state: { lastReferencedRecordIds: ['selected-record'] },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => contextualWorkflowDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('confirmation is still required'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(contextualWorkflowTurn.workflow.status, 'AWAITING_CONFIRMATION');
assert.equal(contextualWorkflowTurn.state.collectedToolFields.contact_name, 'Sam');
assert.deepEqual(contextualWorkflowTurn.state.lastReferencedRecordIds, ['selected-record'],
  'Workflow activation must preserve the selected record reference');
assert.equal(contextualWorkflowDecisions.length, 0);

const confirmationDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} },
  nextQuestion: null,
  stateUpdate: { set: { confirmationStatus: 'confirmed' }, clear: [] },
}, {
  speech: 'The action completed successfully.',
  nextQuestion: { question: 'Would you like further help?', reason: 'Published continuation' },
}];
confirmationDecisions.splice(1, 0, structuredClone(confirmationDecisions[0]));

let correctionState = { activeWorkflowId: workflow.recordId, confirmationStatus: 'awaiting_confirmation',
  collectedToolFields: { recipient: 'self', contact_name: 'Old Name', age: 21, requested_date: 'tomorrow' } };
async function confirmationReviewTurn(utterance, proposed, reviewed, speech = null, interruptedWorkflowRequest = null) {
  const outputs = [proposed, reviewed, ...(speech ? [{ speech }] : [])];
  const result = await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Read back stored details and collect corrections before authorization.',
    latestUtterance: utterance, state: correctionState, interruptedWorkflowRequest,
    assignedTools: [collectionTool], informationFields: collectionFields,
  }, {
    invokeStructuredLlm: async (request) => {
      if (outputs.length === 1 + (speech ? 1 : 0)) {
        assert.match(request.messages.at(-1).content, /WORKFLOW_COLLECTION_REVIEW/u);
      }
      return { output: JSON.stringify(outputs.shift()) };
    },
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
    retrieveEvidence: async () => { throw new Error('Stored values must not be searched'); },
    retrieveSpeculativeEvidence: async () => { bookingSpeculativeCalls += 1; return retrieval; },
    persistWorkflowState: async () => {},
    executeAuthorizedTool: async () => { throw new Error('Corrections and questions cannot execute'); },
    validateGroundedClaims: async (input) => {
      assert.deepEqual(input.callerValues, correctionState.collectedToolFields);
      return { supported: true, requestedFactAddressed: true };
    },
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(outputs.length, 0);
  assert.equal(result.toolExecuted, false);
  correctionState = result.state;
  return result;
}
const readback = await confirmationReviewTurn('What name did you record?', searchDecision,
  collectionResponse('The recorded name is Old Name.'));
assert.equal(readback.speech, 'The recorded name is Old Name.');
await confirmationReviewTurn('The name is wrong', collectionResponse('Who do you mean?'), {
  decision: 'CLARIFY', response: '', search: null, tool: null, nextQuestion: null, stateUpdate: null,
  clarification: { question: 'What is the correct name?', reason: 'Replacement value needed', candidates: [] },
});
for (const [key, value] of [['contact_name', 'Shanmugam'], ['age', 22], ['requested_date', 'Friday'], ['recipient', 'family']]) {
  const before = { ...correctionState.collectedToolFields };
  await confirmationReviewTurn(`Change ${key} to ${value}`, confirmationDecisions[0],
    collectionDecision({ [key]: value }), 'Please confirm the revised details.');
  assert.deepEqual(correctionState.collectedToolFields, { ...before, [key]: value });
  assert.equal(correctionState.confirmationStatus, 'awaiting_confirmation');
}
// A newer fragment cannot authorize stale details while a correction is unfinished.
await confirmationReviewTurn('hmm hmm', confirmationDecisions[0], confirmationDecisions[0],
  'Please confirm the details again.', 'Change contact_name to Arun');
assert.equal(correctionState.confirmationStatus, 'awaiting_confirmation');
await confirmationReviewTurn('hmm hmm', confirmationDecisions[0], collectionDecision({ contact_name: 'Arun' }),
  'Please confirm the revised details.', 'Change contact_name to Arun');
assert.equal(correctionState.collectedToolFields.contact_name, 'Arun');
assert.equal(bookingSpeculativeCalls, 0, 'Collection, correction, readback and confirmation must skip speculative KB retrieval');

// Factual side questions still retrieve normally and retain the active workflow.
for (const confirmationStatus of ['pending_fields', 'awaiting_confirmation']) {
  const sideState = { ...correctionState, confirmationStatus };
  const sideOutputs = [searchDecision,
    ...(confirmationStatus === 'awaiting_confirmation' ? [searchDecision] : []),
    { decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
      evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null }];
  let searches = 0;
  const artifacts = {};
  const sideResult = await runTemplateEngineProductionTurn({
    scope, mainPrompt: 'Use published facts for factual questions.',
    latestUtterance: 'What is the tenant item price?', state: sideState,
    assignedTools: [collectionTool], informationFields: collectionFields,
  }, {
    invokeStructuredLlm: async () => sideOutputs.shift(),
    loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts }),
    retrieveSpeculativeEvidence: async () => { bookingSpeculativeCalls += 1; return retrieval; },
    retrieveEvidence: async (request) => {
      searches += 1;
      assert.equal(request.preloadedArtifacts, artifacts);
      return retrieval;
    },
    persistWorkflowState: async () => { assert.fail('Side question must not advance collection'); },
    executeAuthorizedTool: async () => { assert.fail('Side question must not execute'); },
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    validateToolResultSpeechClaims: async () => ({ supported: true }),
  });
  assert.equal(searches, 1);
  assert.equal(bookingSpeculativeCalls, 0);
  assert.equal(sideOutputs.length, 0);
  assert.equal(sideResult.state.activeWorkflowId, sideState.activeWorkflowId);
  assert.deepEqual(sideResult.state.collectedToolFields, sideState.collectedToolFields);
  assert.equal(sideResult.state.confirmationStatus, confirmationStatus);
  assert.equal(sideResult.toolExecuted, false);
}
let executed = 0;
const confirmedTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-2', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Yes, confirm it.', conversationHistory: [],
  state: {
    activeWorkflowId: 'workflow-1', collectedToolFields: { contact_name: 'Sam' },
    confirmationStatus: 'awaiting_confirmation',
  },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => confirmationDecisions.shift(),
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [workflow], artifacts: {},
    publishedConversationGuidance: [{
      recordId: 'result-guidance', recordType: 'CONVERSATION_NODE',
      tenantId, agentId, knowledgeBaseId, publicationRevision: 4, published: true,
      nodeKey: 'operation_execution_result', intentClass: null,
      purpose: 'Report the verified execution result and offer further help.',
      situation: 'The authorized operation has returned a verified result.',
      examples: [], context: null, catalogReferences: [],
      nextQuestion: 'Would you like further help?',
    }],
  }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {
    executed += 1;
    return { verified: true, success: true, output: { success: true } };
  },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: true }),
});
assert.equal(executed, 1);
assert.equal(confirmedTurn.workflow.status, 'SUCCEEDED');
assert.equal(confirmedTurn.state.activeWorkflowId, null);
assert.equal(confirmedTurn.provenance.finalDecision, 'TOOL_RESULT');
assert.equal(confirmedTurn.provenance.validationResult, 'verified_tool_result');
assert.equal(confirmedTurn.speech,
  'The action completed successfully. Would you like further help?');
assert.equal(confirmedTurn.followUpValidation.accepted, true);
assert.equal(confirmationDecisions.length, 0);

const runtimeMetrics = {
  templateEngine: { version: 1, mode: 'active', turns: 0, searches: 0, workflows: 0 },
  turnLatency: [],
};
const searchMetric = recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch: 1, result: turn, retrievalDiagnostics: retrieval.diagnostics,
  turnStartedAt: 1_000, firstAudioAt: 1_750, finalResponseReadyAt: 2_900,
  finalResponseQueuedAt: 2_920,
  firstFinalAudioAt: 3_200, firstAudioDeadlineMs: 2_000, sttFinalizationMs: 351,
  stageTimings: {
    routing: { durationMs: 500 }, retrieval: { durationMs: 250 },
    generation: { durationMs: 700 }, validation: { durationMs: 150 },
  },
});
recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch: 2, result: workflowTurn, turnStartedAt: 2_000,
  firstAudioAt: 4_500, firstAudioDeadlineMs: 2_000,
});
assert.equal(runtimeMetrics.templateEngine.turns, 2);
assert.equal(runtimeMetrics.templateEngine.searches, 1);
assert.equal(runtimeMetrics.templateEngine.workflows, 1);
assert.equal(runtimeMetrics.turnLatency.length, 2);
assert.equal(searchMetric.route, 'SEARCH');
assert.equal(searchMetric.responseClass, 'RESPONSE');
assert.equal(searchMetric.retrievalMs, retrieval.diagnostics.durationMs);
assert.equal(searchMetric.totalFirstAudioMs, 750);
assert.equal(searchMetric.finalAnswerReadyMs, 1900);
assert.equal(searchMetric.finalAnswerFirstAudioMs, 2200);
assert.equal(searchMetric.answerQueueAfterReadyMs, 20);
assert.equal(searchMetric.finalAnswerAudioAfterQueuedMs, 280);
assert.deepEqual(searchMetric.actualAnswerBaseline, {
  targetMs: 3000,
  maximumMs: 4000,
  normalVerifiedRequest: true,
  actualAnswerFirstAudioMs: 2200,
  targetStatus: 'passed',
  maximumStatus: 'passed',
  stages: {
    sttFinalizationMs: 351, routingMs: 500, retrievalMs: 250,
    generationMs: 700, validationMs: 150, answerQueueMs: 20, ttsFirstAudioMs: 280,
  },
  acknowledgementFirstAudioMs: null,
  acknowledgementExcluded: true,
});
assert.equal(searchMetric.firstAudioStatus, 'passed');
assert.equal(runtimeMetrics.turnLatency[1].retrievalMs, null);
assert.equal(runtimeMetrics.turnLatency[1].firstAudioStatus, 'missed');

console.log('Template-engine production retrieval and turn runtime verification passed.');
