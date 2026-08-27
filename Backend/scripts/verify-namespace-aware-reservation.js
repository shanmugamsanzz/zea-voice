import assert from 'node:assert/strict';
import { searchParallelHybridCandidates } from '../src/knowledge-bases/parallel-hybrid-search.js';

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

const overviewRecord = records[3];
const overviewCandidate = {
  recordId: overviewRecord.record_id,
  recordType: 'CONVERSATION_NODE',
  intentClass: 'CATEGORY_OVERVIEW',
};
const overview = await retrieve(baseInput, {
  ...baseClassification, intentClass: 'CATEGORY_OVERVIEW', candidate: overviewCandidate,
}, {
  ...emptyResolution,
  namespaceCandidates: { CONVERSATION: [overviewCandidate] },
});
assert.equal(overview.queryContext.reservedRecords[0].recordId, overviewRecord.record_id);
assert.equal(overview.queryContext.reservedRecords[0].reason, 'published_overview');

const explicit = await retrieve({
  ...baseInput,
  queryUnderstanding: {
    explicitEntities: [{ recordId: records[0].record_id, recordType: 'CATALOG_ITEM' }],
  },
}, baseClassification, emptyResolution);
assert.equal(explicit.queryContext.reservedRecords[0].recordId, records[0].record_id);
assert.equal(explicit.queryContext.reservedRecords[0].reason, 'explicit_entity');

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
