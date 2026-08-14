import assert from 'node:assert/strict';
import {
  searchPublishedKnowledge,
  searchPublishedKnowledgeOperation,
} from '../src/knowledge-bases/knowledge-runtime.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const documentVersionId = '55555555-5555-4555-8555-555555555555';
const ids = {
  catalog: '60000000-0000-4000-8000-000000000001',
  workflow: '60000000-0000-4000-8000-000000000002',
  conversation: '60000000-0000-4000-8000-000000000003',
  faq: '60000000-0000-4000-8000-000000000004',
  knowledge: '60000000-0000-4000-8000-000000000005',
  stale: '60000000-0000-4000-8000-000000000006',
};
const base = (id) => ({
  id, knowledge_base_id: knowledgeBaseId, document_id: documentId,
  document_version_id: documentVersionId, document_name: 'approved.txt',
  source_page_start: 1, source_page_end: 1,
});
const profile = {
  agent_usage: 'inbound', agent_settings: {},
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 7, priority: 1, semanticReady: true }],
  catalog_items: [{
    ...base(ids.catalog), item_key: 'service-a', name: 'Service A', category: 'Services',
    category_key: 'services', aliases: [], category_aliases: [], description: 'Approved service details.',
    price: '125.00', currency: 'INR', attributes: [], relationships: {}, selection_rules: {},
  }],
  workflows: [{
    ...base(ids.workflow), name: 'send_information', intent: 'send_information', priority: 10,
    conditions: {}, action_type: 'webhook',
    action_config: { responseMode: 'instruction', operation: 'send' },
    response_template: 'Internal instruction that must never be spoken.',
  }],
  conversations: [{
    ...base(ids.conversation), flow_key: 'default', node_key: 'guidance', node_type: 'guidance',
    content: 'Approved conversational guidance.', variables: [], transitions: [], language: 'en',
  }],
  faqs: [{
    ...base(ids.faq), question: 'Where are you located?', answer: 'Approved PostgreSQL answer.', language: 'en',
  }],
  general_knowledge: [{
    ...base(ids.knowledge), source_heading: 'Identity', content: 'Approved general knowledge.', chunk_index: 0,
  }],
};

let searchOptions;
const candidate = (id, recordType, overrides = {}) => ({
  id, score: 0.94,
  payload: {
    tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
    publication_revision: 7, agent_usage: 'INBOUND', assigned_agent_ids: [agentId],
    record_id: id, record_type: recordType,
    content: 'UNTRUSTED QDRANT PAYLOAD', answer: 'UNTRUSTED QDRANT ANSWER',
    ...overrides,
  },
});
const dependencies = {
  ragEnabled: true,
  contextRunner: async (_auth, callback) => callback({
    query: async () => ({ rows: [structuredClone(profile)] }),
  }),
  embed: async () => [0.1],
  search: async (_tenant, _vector, options) => {
    searchOptions = options;
    return [
      candidate(ids.catalog, 'CATALOG_ITEM'), candidate(ids.workflow, 'WORKFLOW_RULE'),
      candidate(ids.conversation, 'CONVERSATION_NODE'), candidate(ids.faq, 'FAQ'),
      candidate(ids.knowledge, 'KNOWLEDGE_CHUNK'),
      candidate(ids.stale, 'FAQ'),
      candidate(ids.faq, 'FAQ', { publication_revision: 6 }),
    ];
  },
  cache: { status: 'ready', get: async () => null, set: async () => 'OK' },
};

const result = await searchPublishedKnowledge({ tenantId }, {
  agentId, query: 'Tell me the location and service details', requestedFacts: ['location', 'price'],
  usageDirection: 'inbound', language: 'en',
}, dependencies);

assert.equal(searchPublishedKnowledgeOperation.name, 'search_published_knowledge');
assert.equal(searchPublishedKnowledgeOperation.inputSchema.additionalProperties, false);
assert.deepEqual(searchPublishedKnowledgeOperation.inputSchema.required, ['semanticQuery']);
assert.equal(result.operation, 'search_published_knowledge');
assert.deepEqual([...searchOptions.recordTypes].sort(), [
  'CATALOG_ITEM', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK', 'WORKFLOW_RULE',
].sort());
assert.equal(searchOptions.agentId, agentId);
assert.deepEqual(searchOptions.knowledgeBases, [{ id: knowledgeBaseId, publicationRevision: 7 }]);
assert.equal(result.sources.length, 3);
assert.equal(result.actionEvidence.length, 1);
assert.equal(result.guidanceEvidence.length, 1);
assert.equal(result.sources.find((source) => source.recordType === 'FAQ').content, 'Approved PostgreSQL answer.');
assert.equal(result.sources.some((source) => source.content.includes('UNTRUSTED QDRANT')), false);
assert.equal(result.sources.some((source) => source.recordId === ids.stale), false);
assert.equal(result.actionEvidence[0].callerFacing, false);
assert.equal(result.guidanceEvidence[0].callerFacing, false);
assert.deepEqual(result.requestedFacts, ['location', 'price']);

console.log('Published PostgreSQL/Qdrant knowledge search verification passed.');
