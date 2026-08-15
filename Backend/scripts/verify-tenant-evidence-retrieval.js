import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'true';

const { retrieveTenantEvidence } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const knowledgeBaseId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const item = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', knowledge_base_id: knowledgeBaseId,
  document_id: documentId, document_version_id: documentId, source_page_start: 1, item_key: 'premium-plan',
  name: 'Premium Plan', category: 'Plans', category_key: 'plans', parent_category_key: null,
  price: 100, currency: 'USD', description: 'Includes priority support.',
  attributes: [{ key: 'coverage', name: 'Coverage', value: 'Priority support and consultation' }],
};
const profile = {
  agent_usage: 'both', agent_settings: {},
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 4, priority: 1, semanticReady: true }],
  workflows: [], conversations: [], faqs: [], catalog_items: [item],
};
let searchInput;
const hydrated = new Map([
  [item.id, {
    record_type: 'CATALOG_ITEM', record_id: item.id, knowledge_base_id: knowledgeBaseId,
    document_id: documentId, document_version_id: documentId, document_name: 'catalog.txt',
    source_page_start: 1, language: 'en', content: 'Premium Plan includes priority support and consultation.',
    caller_facing: true, authoritative_data: {
      itemKey: item.item_key, name: item.name, category: item.category,
      categoryKey: item.category_key, price: item.price, currency: item.currency,
      description: item.description, attributes: item.attributes,
    },
  }],
  ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
    record_type: 'FAQ', record_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', knowledge_base_id: knowledgeBaseId,
    document_id: documentId, document_version_id: documentId, document_name: 'faq.txt',
    source_page_start: 2, language: 'en', content: 'Every Premium Plan includes one consultation.',
    caller_facing: true, authoritative_data: { answer: 'Every Premium Plan includes one consultation.' },
  }],
  ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
    record_type: 'KNOWLEDGE_CHUNK', record_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', knowledge_base_id: knowledgeBaseId,
    document_id: documentId, document_version_id: documentId, document_name: 'knowledge.txt',
    source_page_start: 3, language: 'en', content: 'The consultation is available during business hours.',
    caller_facing: true, authoritative_data: { content: 'The consultation is available during business hours.' },
  }],
]);
const result = await retrieveTenantEvidence({ tenantId }, {
  agentId, usageDirection: 'inbound', language: 'en',
  query: 'Does it include consultation?', selectedCatalogItemKey: 'premium-plan',
  activeCategoryName: 'Plans',
  understanding: { questionType: 'inclusions', selectedEntityKeys: ['premium-plan'] },
}, {
  cache: null,
  contextRunner: async (_auth, callback) => callback({
    query: async (sql, values) => {
      if (!String(sql).includes('jsonb_to_recordset')) return { rows: [profile] };
      const requested = JSON.parse(values[3]);
      return { rows: requested.map((candidate) => {
        const row = hydrated.get(candidate.record_id);
        return row ? { ...row, rank: candidate.rank, score: candidate.score } : null;
      }).filter(Boolean) };
    },
  }),
  embed: async (query) => { assert.match(query, /inclusions/u); return [0.1, 0.2]; },
  search: async (requestedTenantId, _vector, input) => {
    assert.equal(requestedTenantId, tenantId);
    searchInput = input;
    return [
      {
        id: item.id, score: 0.93,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 4,
          agent_usage: 'BOTH', record_id: item.id, record_type: 'CATALOG_ITEM',
          document_id: documentId, document_version_id: documentId,
        },
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', score: 0.91,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 4,
          agent_usage: 'BOTH', record_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          record_type: 'FAQ', document_id: documentId, document_version_id: documentId, page_number: 2,
          answer: 'Every Premium Plan includes one consultation.',
        },
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', score: 0.88,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 4,
          agent_usage: 'BOTH', record_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          record_type: 'KNOWLEDGE_CHUNK', document_id: documentId, document_version_id: documentId, page_number: 3,
          content: 'The consultation is available during business hours.',
        },
      },
      {
        id: 'other-tenant', score: 0.99,
        payload: {
          tenant_id: '99999999-9999-4999-8999-999999999999', knowledge_base_id: knowledgeBaseId,
          publication_revision: 4, agent_usage: 'BOTH', record_type: 'FAQ', answer: 'Must never appear.',
        },
      },
    ];
  },
});

assert.equal(result.found, true);
assert.equal(result.entities[0].key, 'premium-plan');
assert.equal(result.sources.some((source) => source.recordType === 'CATALOG_ITEM'), true);
assert.equal(result.sources.some((source) => source.recordType === 'FAQ'), true);
assert.equal(result.sources.some((source) => source.recordType === 'KNOWLEDGE_CHUNK'), true);
assert.equal(result.sources.some((source) => source.content.includes('Must never appear')), false);
assert.deepEqual(searchInput.recordTypes, ['CATALOG_ITEM', 'WORKFLOW_RULE', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK']);

console.log(JSON.stringify({
  task: 'Full tenant document evidence retrieval',
  understandingDrivesQuery: true,
  sources: ['Catalog', 'Workflow Rules', 'Conversation Script', 'FAQ', 'General Knowledge'],
  tenantIsolationVerified: true,
}, null, 2));
