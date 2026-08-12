import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'true';
process.env.EMBEDDING_BASE_URL ??= 'http://127.0.0.1:1113';
process.env.EMBEDDING_API_KEY ??= 'test-embedding-api-key';
process.env.QDRANT_URL ??= 'http://127.0.0.1:6333';
process.env.QDRANT_API_KEY ??= 'test-qdrant-api-key';
process.env.B2_S3_ENDPOINT ??= 'https://s3.example.invalid';
process.env.B2_BUCKET ??= 'test-bucket';
process.env.B2_BUCKET_ID ??= 'test-bucket-id';
process.env.B2_KEY_ID ??= 'test-key-id';
process.env.B2_APPLICATION_KEY ??= 'test-application-key';

const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';
const comparisonWorkflowId = '55555555-5555-4555-8555-555555555551';
const symptomWorkflowId = '55555555-5555-4555-8555-555555555552';

const workflow = (id, name, triggerPhrases, response) => ({
  id,
  knowledge_base_id: knowledgeBaseId,
  document_id: '66666666-6666-4666-8666-666666666666',
  document_version_id: '77777777-7777-4777-8777-777777777777',
  document_name: 'workflow.txt',
  source_page_start: 1,
  source_page_end: 1,
  name,
  intent: name,
  priority: 10,
  conditions: { triggerPhrases, matchMode: 'any_phrase' },
  action_type: 'respond',
  action_config: { responseMode: 'exact' },
  response_template: response,
});

const catalogItem = (id, name, aliases, order) => ({
  id,
  knowledge_base_id: knowledgeBaseId,
  document_id: '88888888-8888-4888-8888-888888888888',
  document_version_id: '99999999-9999-4999-8999-999999999999',
  document_name: 'catalog.txt',
  source_page_start: 1,
  source_page_end: 1,
  item_key: name.toLowerCase().replace(/\s+/gu, '-'),
  name,
  category: 'Plans',
  category_aliases: ['Options'],
  aliases,
  description: `${name} approved details`,
  price: order === 0 ? 100 : 200,
  currency: 'INR',
  display_order: order,
  attributes: [],
});

const profile = {
  agent_usage: 'inbound',
  agent_settings: {
    knowledgeHighConfidence: 0.86,
    knowledgeClarificationConfidence: 0.64,
    knowledgeAmbiguityMargin: 0.06,
  },
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 4, priority: 0, semanticReady: true }],
  workflows: [
    workflow(
      comparisonWorkflowId,
      'compare_two_plans',
      ['compare Alpha Plan and Beta Plan'],
      'Alpha Plan and Beta Plan approved comparison.',
    ),
    workflow(
      symptomWorkflowId,
      'general_discomfort',
      ['whole body discomfort suitable option'],
      'Approved general screening guidance.',
    ),
  ],
  conversations: [],
  catalog_items: [
    catalogItem('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Alpha Plan', ['Alpha'], 0),
    catalogItem('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Beta Plan', ['Beta'], 1),
  ],
  faqs: [],
};

const cache = { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } };
let embeddingCalls = 0;
const dependencies = {
  cache,
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [profile] }) }),
  embed: async () => { embeddingCalls += 1; return [0.1, 0.2]; },
  search: async (_tenant, _vector, options) => {
    if (!options.recordTypes?.includes('WORKFLOW_RULE')) return [];
    const isComparison = options.recordTypes.includes('WORKFLOW_RULE') && currentQuery.includes('two options');
    const id = isComparison ? comparisonWorkflowId : symptomWorkflowId;
    return [
      {
        id,
        score: 0.99,
        payload: {
          tenant_id: foreignTenantId,
          knowledge_base_id: knowledgeBaseId,
          publication_revision: 4,
          agent_usage: 'BOTH',
          record_type: 'WORKFLOW_RULE',
        },
      },
      {
        id,
        score: currentQuery.includes('unrelated') ? 0.75 : 0.94,
        payload: {
          tenant_id: tenantId,
          knowledge_base_id: knowledgeBaseId,
          publication_revision: 4,
          agent_usage: 'BOTH',
          record_type: 'WORKFLOW_RULE',
        },
      },
    ];
  },
};

let currentQuery = 'How do these two options differ: Alpha Plan and Beta Plan?';
const comparison = await routeKnowledgeQuery({ tenantId }, {
  agentId, query: currentQuery, usageDirection: 'inbound', language: 'en', routeHint: 'auto',
}, dependencies);
assert.equal(comparison.route, 'workflow_hint');
assert.equal(comparison.content, 'Alpha Plan and Beta Plan approved comparison.');
assert.equal(comparison.workflow.matchMethod, 'semantic');
assert.deepEqual(comparison.catalogSelections.map((selection) => selection.item.name), ['Alpha Plan', 'Beta Plan']);

currentQuery = 'I have discomfort across my entire body. Which option may be relevant?';
const symptom = await routeKnowledgeQuery({ tenantId }, {
  agentId, query: currentQuery, usageDirection: 'inbound', language: 'en', routeHint: 'auto',
}, dependencies);
assert.equal(symptom.route, 'workflow_hint');
assert.equal(symptom.content, 'Approved general screening guidance.');

currentQuery = 'unrelated weather question';
const unrelated = await routeKnowledgeQuery({ tenantId }, {
  agentId, query: currentQuery, usageDirection: 'inbound', language: 'en', routeHint: 'auto',
}, dependencies);
assert.equal(unrelated.route, 'none');

const measurements = [];
currentQuery = 'How do these two options differ: Alpha Plan and Beta Plan?';
for (let index = 0; index < 50; index += 1) {
  const startedAt = performance.now();
  await routeKnowledgeQuery({ tenantId }, {
    agentId, query: currentQuery, usageDirection: 'inbound', language: 'en', routeHint: 'auto',
  }, dependencies);
  measurements.push(performance.now() - startedAt);
}
measurements.sort((left, right) => left - right);
const p95Ms = measurements[Math.floor(measurements.length * 0.95)];
assert.ok(p95Ms < 1000, `Semantic Workflow routing p95 must stay under one second; received ${p95Ms}ms`);
assert.equal(embeddingCalls, 53);

console.log(JSON.stringify({
  task: 'Semantic Workflow routing',
  comparisonUsesAllResolvedEntities: true,
  symptomIntentUsesApprovedWorkflow: true,
  lowConfidenceUnrelatedResultSuppressed: true,
  tenantIsolation: true,
  p95Ms: Math.round(p95Ms * 1000) / 1000,
}, null, 2));
