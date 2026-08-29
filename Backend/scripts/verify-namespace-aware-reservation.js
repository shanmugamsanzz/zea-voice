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
const dependencies = {
  embed: async () => [0.1, 0.2],
  search: async () => records.map((record, index) => ({
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
  })),
};

async function retrieve(input, classification, resolution) {
  return searchParallelHybridCandidates({
    input, classification, resolution,
    publicationBundles: [bundle], sparseIndexes: [sparseIndex], limitPerChannel: 12,
  }, dependencies);
}

const independent = await retrieve(baseInput, baseClassification, emptyResolution);
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
  memory: { activeEntity: { recordId: records[0].record_id } },
  queryUnderstanding: { contextDependent: true },
}, baseClassification, { ...emptyResolution, contextDependent: true });
assert.equal(contextual.queryContext.reservedRecords[0].recordId, records[0].record_id);
assert.equal(contextual.queryContext.reservedRecords[0].reason, 'canonical_memory');

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
