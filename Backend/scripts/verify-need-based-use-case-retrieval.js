import assert from 'node:assert/strict';
import {
  enrichPublicationRecord,
  KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
} from '../src/knowledge-engine/publication-index-builder.js';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import {
  understandContextualKnowledgeQuery,
} from '../src/knowledge-engine/contextual-query-understanding.js';
import {
  knowledgeQueryClasses,
  knowledgeSearchIndexes,
} from '../src/knowledge-engine/query-classifier.js';
import {
  searchParallelHybridCandidates,
} from '../src/knowledge-bases/parallel-hybrid-search.js';
import { buildRevisionSparseIndex } from '../src/knowledge-bases/knowledge-map.service.js';

const tenantId = '71000000-0000-4000-8000-000000000001';
const agentId = '71000000-0000-4000-8000-000000000002';
const callId = '71000000-0000-4000-8000-000000000003';
const knowledgeBaseId = '71000000-0000-4000-8000-000000000004';
const documentId = '71000000-0000-4000-8000-000000000005';
const documentVersionId = '71000000-0000-4000-8000-000000000006';
const recordId = '71000000-0000-4000-8000-000000000007';

const record = enrichPublicationRecord({
  record_id: recordId,
  record_type: 'catalog_item',
  document_id: documentId,
  document_version_id: documentVersionId,
  usage_direction: 'both',
  language: 'und',
  entity_name: 'Orbit Relay',
  entity_category: 'Signal Systems',
  entity_aliases: ['Relay Core'],
  entity_category_aliases: ['Signal Tools'],
  content: 'Coordinates distributed sensor monitoring across remote sites.',
  entity_metadata: {
    itemKey: 'orbit-relay',
    categoryKey: 'signal-systems',
    capabilities: ['distributed sensor monitoring'],
    relationships: { supports: ['remote site coordination'] },
    selectionRules: { recommendedFor: ['teams managing disconnected sensors'] },
  },
});
assert.ok(record.publicationUseCasePhrases.includes('distributed sensor monitoring'));
assert.ok(record.publicationUseCasePhrases.includes('remote site coordination'));
assert.ok(record.publicationUseCaseTokens.includes('sensors'));

const recentRelevantTurns = [
  { role: 'user', content: 'Our devices are spread across separate locations.' },
  { role: 'assistant', content: 'What outcome are you trying to improve?' },
];
const initialInput = createKnowledgeEngineInput({
  tenantId, agentId, callId,
  utterance: 'Managing disconnected sensors across remote sites is difficult.',
  usageDirection: 'inbound',
  recentRelevantTurns,
  memory: { collectedInformation: { deployment_shape: 'distributed sites' } },
});
const resolution = Object.freeze({
  tenantId, agentId, callId,
  action: 'SEARCH', score: 0,
  routingCandidates: Object.freeze([]),
  namespaceCandidates: Object.freeze({}),
  alternatives: Object.freeze([]),
});
const understanding = understandContextualKnowledgeQuery(initialInput, resolution);
assert.equal(understanding.need.detected, true);
assert.equal(understanding.need.requiresGroundedInterpretation, true);
assert.match(understanding.need.customerProblem, /disconnected sensors/u);
assert.equal(understanding.need.businessContext.deployment_shape, 'distributed sites');

const input = createKnowledgeEngineInput({
  ...initialInput,
  queryUnderstanding: understanding,
  recentRelevantTurns,
  memory: initialInput.memory,
});
const classification = Object.freeze({
  tenantId, agentId, callId,
  intentClass: knowledgeQueryClasses.UNKNOWN,
  selectedNamespace: null,
  relevantNamespaces: Object.freeze(['CATALOG', 'GENERAL']),
  retrievalPlan: Object.freeze({
    indexes: Object.freeze([
      knowledgeSearchIndexes.CATALOG,
      knowledgeSearchIndexes.GENERAL,
      knowledgeSearchIndexes.BM25,
      knowledgeSearchIndexes.SEMANTIC,
    ]),
  }),
});
const job = {
  tenant_id: tenantId,
  knowledge_base_id: knowledgeBaseId,
  targetRevision: 3,
  assigned_agent_ids: [agentId],
  knowledge_base_usage: 'both',
};
const bundle = Object.freeze({
  version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
  tenantId,
  knowledgeBaseId,
  publicationRevision: 3,
  assignedAgentIds: Object.freeze([agentId]),
  records: Object.freeze([record]),
});
const sparseIndex = buildRevisionSparseIndex(job, [record]);
const started = [];
const retrieval = await searchParallelHybridCandidates({
  input,
  classification,
  resolution,
  publicationBundles: [bundle],
  sparseIndexes: [sparseIndex],
}, {
  onChannelStart: (channel) => started.push(channel),
  embed: async () => [0.1, 0.2],
  search: async () => [{
    id: recordId,
    score: 0.91,
    payload: {
      tenant_id: tenantId,
      knowledge_base_id: knowledgeBaseId,
      publication_revision: 3,
      record_type: 'CATALOG_ITEM',
      record_id: recordId,
      agent_usage: 'both',
    },
  }],
});
assert.deepEqual(new Set(started), new Set(['structured', 'bm25', 'qdrant']));
assert.equal(retrieval.channels.structured[0].recordId, recordId);
assert.ok(retrieval.channels.bm25.some((candidate) => candidate.recordId === recordId));
assert.ok(retrieval.channels.qdrant.some((candidate) => candidate.recordId === recordId));
assert.match(retrieval.queryContext.semanticText, /distributed sites/u);
assert.doesNotMatch(retrieval.queryContext.semanticText, /separate locations/u,
  'A new standalone need must not inherit unrelated prior-turn wording');
assert.equal(retrieval.queryContext.need.detected, true);
assert.deepEqual(retrieval.queryContext.reservedRecords, [],
  'Use-case discovery remains ranked evidence and must not become canonical reservation state');
assert.deepEqual(retrieval.channelFailures, []);

console.log('Universal need understanding and tenant-driven use-case retrieval verified.');
