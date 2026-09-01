import assert from 'node:assert/strict';
import { searchParallelHybridCandidates } from '../src/knowledge-bases/parallel-hybrid-search.js';
import { fuseCandidateRankings } from '../src/knowledge-engine/authoritative-evidence.js';

const tenantId = 'b8000000-0000-4000-8000-000000000001';
const agentId = 'b8000000-0000-4000-8000-000000000002';
const callId = 'b8000000-0000-4000-8000-000000000003';
const knowledgeBaseId = 'b8000000-0000-4000-8000-000000000004';
const records = [
  ['b8000000-0000-4000-8100-000000000001', 'CATALOG_ITEM'],
  ['b8000000-0000-4000-8100-000000000002', 'CATALOG_ITEM'],
  ['b8000000-0000-4000-8100-000000000003', 'FAQ'],
  ['b8000000-0000-4000-8100-000000000004', 'CONVERSATION_NODE'],
  ['b8000000-0000-4000-8100-000000000005', 'WORKFLOW_RULE'],
  ['b8000000-0000-4000-8100-000000000006', 'KNOWLEDGE_CHUNK'],
].map(([recordId, recordType]) => ({
  record_id: recordId,
  record_type: recordType,
  usage_direction: 'both',
  entity_metadata: recordType === 'CONVERSATION_NODE'
    ? { intentClass: 'CATEGORY_OVERVIEW', nodeType: 'message' } : {},
}));
const bundle = {
  tenantId, knowledgeBaseId, publicationRevision: 7,
  assignedAgentIds: [agentId], records,
};
const sparseIndex = {
  documents: records.map((record) => ({
    id: record.record_id,
    recordType: record.record_type,
    tenantId, knowledgeBaseId, publicationRevision: 7,
    usageDirection: 'both', tokens: ['shared', 'published', 'question'],
  })),
};
const baseInput = {
  tenantId, agentId, callId, utterance: 'shared published question',
  usageDirection: 'inbound', memory: {}, queryUnderstanding: {},
};
const baseClassification = {
  tenantId, agentId, callId, intentClass: 'UNKNOWN',
  retrievalPlan: { indexes: [] },
};
const emptyResolution = {
  candidate: null, candidateNamespace: null, routingCandidates: [], namespaceCandidates: {},
};
const semanticSearchScopes = [];
const dependencies = {
  embed: async () => [0.1, 0.2],
  search: async (_tenant, _vector, options = {}) => {
    semanticSearchScopes.push([...(options.recordTypes ?? [])].sort());
    return records.filter((record) => (options.recordTypes ?? []).includes(
      record.record_type,
    )).map((record, index) => ({
    id: record.record_id,
    score: 0.99 - index * 0.01,
    payload: {
      tenant_id: tenantId,
      knowledge_base_id: knowledgeBaseId,
      publication_revision: 7,
      record_type: record.record_type,
      record_id: record.record_id,
      agent_usage: 'both',
    },
    }));
  },
};

async function retrieve(input, classification, resolution) {
  return searchParallelHybridCandidates({
    input, classification, resolution,
    publicationBundles: [bundle], sparseIndexes: [sparseIndex], limitPerChannel: 12,
  }, dependencies);
}

const independent = await retrieve(baseInput, baseClassification, emptyResolution);
assert.deepEqual(semanticSearchScopes.slice(0, 5), [
  ['CATALOG_CATEGORY', 'CATALOG_ITEM'], ['FAQ'], ['CONVERSATION_NODE'],
  ['WORKFLOW_RULE'], ['KNOWLEDGE_CHUNK'],
], 'Qdrant must be searched independently with one namespace-scoped filter per call');
for (const channel of ['structured', 'bm25', 'qdrant']) {
  assert.deepEqual(Object.keys(independent.namespaceChannels[channel]), [
    'CATALOG', 'FAQ', 'CONVERSATION', 'WORKFLOW', 'GENERAL',
  ]);
}
for (const namespace of ['CATALOG', 'FAQ', 'CONVERSATION', 'WORKFLOW', 'GENERAL']) {
  assert.ok(independent.namespaceChannels.bm25[namespace].length > 0);
  assert.ok(independent.namespaceChannels.qdrant[namespace].length > 0);
}
const callerFacingFusion = fuseCandidateRankings(independent, {
  limit: 5, minProviderScore: 0,
});
assert.equal(callerFacingFusion.candidates.length, 5);
assert.equal(callerFacingFusion.candidates.every(
  (candidate) => candidate.callerFacingHint === true,
), true, 'Unrelated internal guidance must not occupy caller-facing top-five positions');

const channelCandidate = (channel, recordType) => independent.channels[channel]
  .find((candidate) => candidate.recordType === recordType);
const reservedCatalogCandidate = channelCandidate('bm25', 'CATALOG_ITEM');
const corroboratedFaq = channelCandidate('bm25', 'FAQ');
const semanticFaq = channelCandidate('qdrant', 'FAQ');
const unrelatedConversation = channelCandidate('qdrant', 'CONVERSATION_NODE');
const isolatedLatestIntentFusion = fuseCandidateRankings({
  ...independent,
  primaryNamespaces: ['CATALOG'],
  queryContext: {
    ...independent.queryContext,
    reservedRecords: [{
      recordId: reservedCatalogCandidate.recordId,
      recordType: 'CATALOG_ITEM', reason: 'explicit_entity',
    }],
  },
  channels: {
    structured: [{ ...reservedCatalogCandidate, score: 1, rank: 1, namespaceRank: 1 }],
    bm25: [corroboratedFaq],
    qdrant: [semanticFaq, unrelatedConversation],
  },
}, { limit: 5, minProviderScore: 0, highProviderScore: 0.86 });
assert.ok(isolatedLatestIntentFusion.candidates.some((candidate) => (
  candidate.recordId === reservedCatalogCandidate.recordId
)), 'The explicit latest entity must be reserved');
assert.ok(isolatedLatestIntentFusion.candidates.some((candidate) => (
  candidate.recordId === corroboratedFaq.recordId
)), 'Strongly corroborated caller-facing fallback evidence may remain');
assert.equal(isolatedLatestIntentFusion.candidates.some((candidate) => (
  candidate.recordId === unrelatedConversation.recordId
)), false, 'A lone unrelated fallback match must not occupy a top-five slot');
assert.ok(isolatedLatestIntentFusion.rejectedUnrelatedNamespaceIds.includes(
  unrelatedConversation.recordId.toLocaleLowerCase(),
));

const expectedTypesByNamespace = {
  CATALOG: ['CATALOG_ITEM', 'CATALOG_CATEGORY'],
  FAQ: ['FAQ'],
  CONVERSATION: ['CONVERSATION_NODE'],
  WORKFLOW: ['WORKFLOW_RULE'],
  GENERAL: ['KNOWLEDGE_CHUNK'],
};
for (const [namespace, expectedTypes] of Object.entries(expectedTypesByNamespace)) {
  const isolated = await retrieve(baseInput, {
    ...baseClassification,
    intentClass: 'KNOWN_INFORMATION',
    selectedNamespace: namespace,
    retrievalPlan: { indexes: [namespace] },
  }, emptyResolution);
  assert.equal(isolated.relevantNamespaces[0], namespace);
  assert.equal(isolated.primaryNamespaces[0], namespace);
  assert.deepEqual(new Set(isolated.relevantNamespaces), new Set([
    'CATALOG', 'FAQ', 'CONVERSATION', 'WORKFLOW', 'GENERAL',
  ]));
  for (const channel of ['structured', 'bm25', 'qdrant']) {
    assert.equal((isolated.namespaceChannels[channel]?.[namespace] ?? []).every((candidate) => (
      expectedTypes.includes(candidate.recordType)
    )), true, `${namespace} namespace mixed unrelated ${channel} evidence`);
  }
}

const faqFocused = await retrieve(baseInput, {
  ...baseClassification,
  intentClass: 'KNOWN_INFORMATION',
  selectedNamespace: 'FAQ',
  retrievalPlan: { indexes: ['FAQ'] },
}, emptyResolution);
const faqFocusedFusion = fuseCandidateRankings(faqFocused, { limit: 5, minProviderScore: 0 });
assert.equal(faqFocusedFusion.candidates[0].recordType, 'FAQ',
  'The latest-request primary namespace must rank before unrelated fallback namespaces');

const latestFaqCandidate = {
  recordId: records[2].record_id, recordType: 'FAQ', score: 0.95,
};
const latestFaq = await retrieve(baseInput, {
  ...baseClassification,
  intentClass: 'KNOWN_INFORMATION', candidate: latestFaqCandidate,
  selectedNamespace: 'FAQ', confidenceConfiguration: { highConfidence: 0.86 },
  retrievalPlan: { indexes: ['FAQ'] },
}, { ...emptyResolution, candidate: latestFaqCandidate, candidateNamespace: 'FAQ' });
assert.equal(latestFaq.queryContext.reservedRecords[0].recordId, records[2].record_id);
assert.equal(latestFaq.queryContext.reservedRecords[0].reason, 'latest_request_record');

const overviewRecord = records[3];
const overviewCandidate = {
  recordId: overviewRecord.record_id,
  recordType: 'CONVERSATION_NODE',
  intentClass: 'CATEGORY_OVERVIEW',
};
const overview = await retrieve(baseInput, {
  ...baseClassification, intentClass: 'CATEGORY_OVERVIEW', candidate: overviewCandidate,
  selectedNamespace: 'CATALOG',
  retrievalPlan: { indexes: ['CATALOG', 'CONVERSATION'] },
}, {
  ...emptyResolution,
  namespaceCandidates: { CONVERSATION: [overviewCandidate] },
});
assert.equal(overview.queryContext.reservedRecords[0].recordId, overviewRecord.record_id);
assert.equal(overview.queryContext.reservedRecords[0].reason, 'published_overview');
assert.deepEqual(new Set(overview.relevantNamespaces), new Set([
  'CATALOG', 'FAQ', 'CONVERSATION', 'WORKFLOW', 'GENERAL',
]));
assert.equal(overview.namespaceChannels.bm25.CONVERSATION.every((candidate) => (
  candidate.recordType === 'CONVERSATION_NODE'
)), true, 'Overview retrieval must preserve independent namespace channels');

const explicit = await retrieve({
  ...baseInput,
  queryUnderstanding: {
    explicitEntities: [{ recordId: records[0].record_id, recordType: 'CATALOG_ITEM' }],
  },
}, baseClassification, emptyResolution);
assert.equal(explicit.queryContext.reservedRecords[0].recordId, records[0].record_id);
assert.equal(explicit.queryContext.reservedRecords[0].reason, 'explicit_entity');
assert.equal(explicit.relevantNamespaces[0], 'CATALOG');
assert.deepEqual(new Set(explicit.relevantNamespaces), new Set([
  'CATALOG', 'FAQ', 'CONVERSATION', 'WORKFLOW', 'GENERAL',
]));

const contextual = await retrieve({
  ...baseInput,
  memory: { activeEntity: { recordId: records[0].record_id, name: 'Published Option' } },
  recentRelevantTurns: [
    { role: 'user', content: 'obsolete unrelated historical wording' },
    { role: 'assistant', content: 'obsolete historical response' },
  ],
  queryUnderstanding: { contextDependent: true, requestedFacts: ['configured_value'] },
}, baseClassification, { ...emptyResolution, contextDependent: true });
assert.equal(contextual.queryContext.reservedRecords[0].recordId, records[0].record_id);
assert.equal(contextual.queryContext.reservedRecords[0].reason, 'canonical_memory');
assert.match(contextual.queryContext.latestRequestText, /Published Option/u);
assert.match(contextual.queryContext.latestRequestText, /configured_value/u);
assert.doesNotMatch(contextual.queryContext.latestRequestText, /obsolete unrelated/u,
  'Historical dialogue must not dilute the latest-request retrieval query');
assert.match(contextual.queryContext.contextualText, /obsolete unrelated/u,
  'Relevant memory remains available as contextual trace without becoming the primary query');

const comparison = await retrieve({
  ...baseInput,
  queryUnderstanding: {
    comparisonEntities: [
      { recordId: records[0].record_id, recordType: 'CATALOG_ITEM' },
      { recordId: records[1].record_id, recordType: 'CATALOG_ITEM' },
    ],
  },
}, { ...baseClassification, intentClass: 'COMPARISON_COMPLEX' }, emptyResolution);
assert.deepEqual(comparison.queryContext.reservedRecords.map((record) => record.recordId), [
  records[0].record_id, records[1].record_id,
]);
assert.equal(comparison.queryContext.reservedRecords.every(
  (record) => record.reason === 'explicit_comparison',
), true);

console.log('Independent namespace search and pre-RRF record reservation verified.');
