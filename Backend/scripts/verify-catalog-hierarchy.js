import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';
process.env.B2_S3_ENDPOINT ??= 'https://s3.example.invalid';
process.env.B2_BUCKET ??= 'test-bucket';
process.env.B2_BUCKET_ID ??= 'test-bucket-id';
process.env.B2_KEY_ID ??= 'test-key-id';
process.env.B2_APPLICATION_KEY ??= 'test-application-key';

const { processExtractedCategory } = await import('../src/knowledge-bases/category-processors.js');
const { classifyCatalogEntityLocally } = await import('../src/knowledge-bases/catalog-entity-resolver.js');
const { buildSemanticPoint } = await import('../src/knowledge-bases/semantic-index.service.js');
const { updateReviewRecordSchema } = await import('../src/knowledge-bases/knowledge-review.schemas.js');
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const source = [
  'CATEGORY: Service Plans | KEY=service-plans | PARENT=all-offerings | ALIASES=Plans, Options | DESCRIPTION=Available service tiers | DEFAULT_SELECTION={"strategy":"clarify","defaultItemKey":"standard-plan"}',
  'Standard Plan INR 100 | KEY=standard-plan | ALIASES=Standard, Basic | DESCRIPTION=Standard approved service | RELATIONSHIPS={"alternatives":["premium-plan"]} | SELECTION_RULES={"allowedIntents":["details","select"]}',
  'Premium Plan INR 200 | KEY=premium-plan | ALIASES=Premium, Advanced | DESCRIPTION=Premium approved service | RELATIONSHIPS={"alternatives":["standard-plan"]}',
].join('\n');

const extracted = processExtractedCategory('catalog', {
  fullText: source,
  pages: [{ pageNumber: 1, lines: source.split('\n') }],
});
assert.equal(extracted.recordCount, 2);
assert.deepEqual(extracted.warnings, []);
assert.equal(extracted.catalog.categories.length, 1);
assert.deepEqual(extracted.catalog.categories[0], {
  key: 'service-plans',
  name: 'Service Plans',
  parentKey: 'all-offerings',
  aliases: ['Plans', 'Options'],
  description: 'Available service tiers',
  defaultSelectionRules: { strategy: 'clarify', defaultItemKey: 'standard-plan' },
});

const [standard, premium] = extracted.records;
assert.equal(standard.itemKey, 'standard-plan');
assert.equal(standard.categoryKey, 'service-plans');
assert.equal(standard.parentCategoryKey, 'all-offerings');
assert.equal(standard.categoryDescription, 'Available service tiers');
assert.deepEqual(standard.categorySelectionRules, { strategy: 'clarify', defaultItemKey: 'standard-plan' });
assert.equal(standard.description, 'Standard approved service');
assert.deepEqual(standard.relationships, { alternatives: ['premium-plan'] });
assert.deepEqual(standard.selectionRules, { allowedIntents: ['details', 'select'] });
assert.equal(premium.itemKey, 'premium-plan');

const malformed = processExtractedCategory('catalog', {
  fullText: 'CATEGORY: Plans | DEFAULT_SELECTION=not-json\nPlan One INR 10 | RELATIONSHIPS=[]',
  pages: [{ pageNumber: 1, lines: [
    'CATEGORY: Plans | DEFAULT_SELECTION=not-json',
    'Plan One INR 10 | RELATIONSHIPS=[]',
  ] }],
});
assert.equal(malformed.recordCount, 1);
assert.equal(malformed.warnings.length, 2);

const tenantId = '11111111-1111-4111-8111-111111111111';
const knowledgeBaseId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const agentId = '55555555-5555-4555-8555-555555555555';
const runtimeItems = extracted.records.map((record, index) => ({
  id: index === 0
    ? '66666666-6666-4666-8666-666666666661'
    : '66666666-6666-4666-8666-666666666662',
  knowledge_base_id: knowledgeBaseId,
  document_id: documentId,
  document_version_id: versionId,
  document_name: 'catalog.txt',
  source_page_start: 1,
  source_page_end: 1,
  item_key: record.itemKey,
  name: record.name,
  category: record.category,
  category_key: record.categoryKey,
  parent_category_key: record.parentCategoryKey,
  category_description: record.categoryDescription,
  category_selection_rules: record.categorySelectionRules,
  category_aliases: record.categoryAliases,
  aliases: record.aliases,
  relationships: record.relationships,
  selection_rules: record.selectionRules,
  description: record.description,
  price: record.price,
  currency: record.currency,
  display_order: record.displayOrder,
  attributes: [],
}));

const categoryResolution = classifyCatalogEntityLocally(runtimeItems, 'Options', {
  highConfidence: 0.86,
  clarificationConfidence: 0.64,
  ambiguityMargin: 0.06,
});
assert.equal(categoryResolution.status, 'match');
assert.equal(categoryResolution.entityType, 'category');
assert.equal(categoryResolution.categoryKey, 'service-plans');
assert.equal(categoryResolution.parentCategoryKey, 'all-offerings');
assert.deepEqual(categoryResolution.categorySelectionRules, {
  strategy: 'clarify', defaultItemKey: 'standard-plan',
});

const review = updateReviewRecordSchema.safeParse({
  itemKey: 'standard-plan',
  categoryKey: 'service-plans',
  parentCategoryKey: 'all-offerings',
  categoryDescription: 'Available service tiers',
  categorySelectionRules: { strategy: 'clarify' },
  relationships: { alternatives: ['premium-plan'] },
  selectionRules: { allowedIntents: ['details'] },
});
assert.equal(review.success, true);

const point = buildSemanticPoint({
  tenant_id: tenantId,
  knowledge_base_id: knowledgeBaseId,
  targetRevision: 2,
}, {
  record_id: runtimeItems[0].id,
  record_type: 'catalog_item',
  document_id: documentId,
  document_version_id: versionId,
  usage_direction: 'both',
  source_page_start: 1,
  content: 'Catalog item: Standard Plan',
  entity_name: 'Standard Plan',
  entity_category: 'Service Plans',
  entity_aliases: ['Standard', 'Basic'],
  entity_category_aliases: ['Plans', 'Options'],
  entity_metadata: {
    itemKey: 'standard-plan',
    categoryKey: 'service-plans',
    parentCategoryKey: 'all-offerings',
    relationships: { alternatives: ['premium-plan'] },
  },
}, [0.1, 0.2]);
assert.equal(point.payload.tenant_id, tenantId);
assert.equal(point.payload.entity_metadata.categoryKey, 'service-plans');
assert.deepEqual(point.payload.entity_metadata.relationships, { alternatives: ['premium-plan'] });

const profile = {
  agent_usage: 'inbound',
  agent_settings: {},
  knowledge_bases: [],
  workflows: [],
  conversations: [],
  catalog_items: runtimeItems,
  faqs: [],
};
const routed = await routeKnowledgeQuery({ tenantId }, {
  agentId,
  query: 'Options',
  usageDirection: 'inbound',
  language: 'en',
  routeHint: 'auto',
}, {
  cache: { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } },
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [profile] }) }),
  embed: async () => { throw new Error('Hierarchy alias must resolve locally'); },
  search: async () => { throw new Error('Hierarchy alias must resolve locally'); },
});
assert.equal(routed.route, 'catalog');
assert.equal(routed.category.key, 'service-plans');
assert.equal(routed.category.parentKey, 'all-offerings');
assert.equal(routed.category.items.length, 2);
assert.deepEqual(routed.category.selectionRules, { strategy: 'clarify', defaultItemKey: 'standard-plan' });

console.log(JSON.stringify({
  task: 'Document-driven Catalog hierarchy',
  categories: extracted.catalog.categories.length,
  childItems: extracted.recordCount,
  aliasesIndexed: true,
  relationshipsIndexed: true,
  defaultSelectionRulesSupported: true,
  tenantAndAgentRuntimeScope: true,
  industryHardcoding: false,
}, null, 2));
