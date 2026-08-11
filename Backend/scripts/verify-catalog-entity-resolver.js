import assert from 'node:assert/strict';

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

const {
  phoneticCatalogToken,
  resolveCatalogEntityLocally,
} = await import('../src/knowledge-bases/catalog-entity-resolver.js');
const { processExtractedCategory } = await import('../src/knowledge-bases/category-processors.js');
const { buildSemanticPoint } = await import('../src/knowledge-bases/semantic-index.service.js');
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const documentVersionId = '55555555-5555-4555-8555-555555555555';
const agentId = '66666666-6666-4666-8666-666666666666';
const lungsItemId = '77777777-7777-4777-8777-777777777777';
const liverItemId = '88888888-8888-4888-8888-888888888888';

const extractionText = [
  'CATEGORY: Organ-Specific Packages',
  'Lungs Health Checkup - INR 999 | ALIASES=Lung, Pulmonary Screening, Respiratory Check',
  'Liver Health Checkup - INR 1400 | CATEGORY=Liver Care | ALIASES=Hepatic Screening',
].join('\n');
const extracted = processExtractedCategory('catalog', {
  fullText: extractionText,
  pages: [{ pageNumber: 1, lines: extractionText.split('\n') }],
});
assert.equal(extracted.recordCount, 2);
assert.equal(extracted.records[0].category, 'Organ-Specific Packages');
assert.deepEqual(extracted.records[0].aliases, ['Lung', 'Pulmonary Screening', 'Respiratory Check']);
assert.equal(extracted.records[1].category, 'Liver Care');
assert.deepEqual(extracted.records[1].aliases, ['Hepatic Screening']);

const catalogItems = [
  {
    id: lungsItemId,
    knowledge_base_id: knowledgeBaseId,
    document_id: documentId,
    document_version_id: documentVersionId,
    document_name: 'catalog.txt',
    source_page_start: 1,
    source_page_end: 1,
    item_key: 'lungs-health-checkup',
    name: 'Lungs Health Checkup',
    category: 'Organ-Specific Packages',
    aliases: ['Pulmonary Screening'],
    description: 'Respiratory screening',
    price: 999,
    currency: 'INR',
    display_order: 0,
    attributes: [],
  },
  {
    id: liverItemId,
    knowledge_base_id: knowledgeBaseId,
    document_id: documentId,
    document_version_id: documentVersionId,
    document_name: 'catalog.txt',
    source_page_start: 2,
    source_page_end: 2,
    item_key: 'liver-health-checkup',
    name: 'Liver Health Checkup',
    category: 'Organ-Specific Packages',
    aliases: ['Hepatic Screening'],
    description: 'Liver screening',
    price: 1400,
    currency: 'INR',
    display_order: 1,
    attributes: [],
  },
];

assert.equal(phoneticCatalogToken('Lunch'), phoneticCatalogToken('Lungs'));
assert.equal(resolveCatalogEntityLocally(catalogItems, 'Lung')?.item.id, lungsItemId);
assert.equal(resolveCatalogEntityLocally(catalogItems, 'Lungs package')?.item.id, lungsItemId);
assert.equal(resolveCatalogEntityLocally(catalogItems, 'Lunch package')?.item.id, lungsItemId);
assert.equal(resolveCatalogEntityLocally(catalogItems, 'lunks package')?.item.id, lungsItemId);
assert.equal(resolveCatalogEntityLocally(catalogItems, 'Pulmonary Screening')?.item.id, lungsItemId);
const categoryResolution = resolveCatalogEntityLocally(catalogItems, 'Organ-Specific Packages');
assert.equal(categoryResolution?.entityType, 'category');
assert.equal(categoryResolution?.category, 'Organ-Specific Packages');
assert.deepEqual(categoryResolution?.items.map((item) => item.id), [lungsItemId, liverItemId]);
assert.equal(resolveCatalogEntityLocally(catalogItems, 'Singer package'), null);

const point = buildSemanticPoint({
  tenant_id: tenantId,
  knowledge_base_id: knowledgeBaseId,
  targetRevision: 3,
}, {
  record_id: lungsItemId,
  record_type: 'catalog_item',
  document_id: documentId,
  document_version_id: documentVersionId,
  usage_direction: 'both',
  source_page_start: 1,
  content: 'Catalog item: Lungs Health Checkup',
  entity_name: 'Lungs Health Checkup',
  entity_category: 'Organ-Specific Packages',
  entity_aliases: ['Lung', 'Pulmonary Screening'],
}, [0.1, 0.2]);
assert.equal(point.payload.record_type, 'CATALOG_ITEM');
assert.equal(point.payload.entity_name, 'Lungs Health Checkup');
assert.equal(point.payload.entity_category, 'Organ-Specific Packages');
assert.deepEqual(point.payload.entity_aliases, ['Lung', 'Pulmonary Screening']);
assert.equal(point.payload.tenant_id, tenantId);

const profile = {
  agent_usage: 'inbound',
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 3, priority: 0, semanticReady: true }],
  workflows: [],
  conversations: [],
  catalog_items: catalogItems,
  faqs: [],
};
const cacheValues = new Map();
const cache = {
  async get(key) { return cacheValues.get(key) ?? null; },
  async set(key, value) { cacheValues.set(key, value); return 'OK'; },
};
let semanticSearchOptions;
const dependencies = {
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [profile] }) }),
  cache,
  embed: async () => [0.1, 0.2],
  search: async (_tenant, _vector, options) => {
    semanticSearchOptions = options;
    return [
      {
        id: liverItemId,
        score: 0.99,
        payload: {
          tenant_id: otherTenantId,
          knowledge_base_id: knowledgeBaseId,
          publication_revision: 3,
          agent_usage: 'BOTH',
          record_type: 'CATALOG_ITEM',
          entity_name: 'Foreign result',
        },
      },
      {
        id: lungsItemId,
        score: 0.93,
        payload: {
          tenant_id: tenantId,
          knowledge_base_id: knowledgeBaseId,
          publication_revision: 3,
          agent_usage: 'BOTH',
          record_type: 'CATALOG_ITEM',
          entity_name: 'Lungs Health Checkup',
        },
      },
    ];
  },
};
const semantic = await routeKnowledgeQuery({ tenantId }, {
  agentId,
  query: 'நுரையீரல் பரிசோதனை',
  usageDirection: 'inbound',
  language: 'ta',
  routeHint: 'auto',
}, dependencies);
assert.equal(semantic.route, 'catalog');
assert.equal(semantic.item.name, 'Lungs Health Checkup');
assert.equal(semantic.entityResolution.method, 'semantic');
assert.deepEqual(semanticSearchOptions.recordTypes, ['CATALOG_ITEM']);

const semanticCategory = await routeKnowledgeQuery({ tenantId }, {
  agentId,
  query: '\u0b89\u0bb1\u0bc1\u0baa\u0bcd\u0baa\u0bc1 \u0baa\u0bb0\u0bbf\u0b9a\u0bcb\u0ba4\u0ba9\u0bc8\u0b95\u0bb3\u0bcd',
  usageDirection: 'inbound',
  language: 'ta-category',
  routeHint: 'auto',
}, {
  ...dependencies,
  search: async () => [
    {
      id: lungsItemId,
      score: 0.94,
      payload: {
        tenant_id: tenantId,
        knowledge_base_id: knowledgeBaseId,
        publication_revision: 3,
        agent_usage: 'BOTH',
        record_type: 'CATALOG_ITEM',
        entity_name: 'Lungs Health Checkup',
        entity_category: 'Organ-Specific Packages',
      },
    },
    {
      id: liverItemId,
      score: 0.92,
      payload: {
        tenant_id: tenantId,
        knowledge_base_id: knowledgeBaseId,
        publication_revision: 3,
        agent_usage: 'BOTH',
        record_type: 'CATALOG_ITEM',
        entity_name: 'Liver Health Checkup',
        entity_category: 'Organ-Specific Packages',
      },
    },
  ],
});
assert.equal(semanticCategory.route, 'catalog');
assert.equal(semanticCategory.entityResolution.matchedKind, 'category');
assert.equal(semanticCategory.category.name, 'Organ-Specific Packages');
assert.deepEqual(semanticCategory.category.items.map((item) => item.name), [
  'Lungs Health Checkup', 'Liver Health Checkup',
]);

const local = await routeKnowledgeQuery({ tenantId }, {
  agentId,
  query: 'Lunch package',
  usageDirection: 'inbound',
  language: 'en',
  routeHint: 'auto',
}, { ...dependencies, search: async () => { throw new Error('Local resolution must not search Qdrant'); } });
assert.equal(local.route, 'catalog');
assert.equal(local.item.name, 'Lungs Health Checkup');
assert.equal(local.entityResolution.method, 'phonetic');

console.log(JSON.stringify({
  task: 'Generic Catalog entity resolver',
  parsedCatalogItems: extracted.recordCount,
  localMethods: ['normalized', 'phonetic', 'fuzzy'],
  semanticIndexRecordType: point.payload.record_type,
  semanticTenantIsolation: true,
  sharedCategoryResolvedWithoutArbitraryItem: true,
}, null, 2));
