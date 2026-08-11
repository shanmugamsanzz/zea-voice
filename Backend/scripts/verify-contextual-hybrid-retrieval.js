import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';

const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');
const { runtimeKnowledgeQuerySchema } = await import('../src/knowledge-bases/knowledge-runtime.schemas.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const knowledgeBaseId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555';

function catalogItem(id, key, name, category, categoryKey, aliases = []) {
  return {
    id, knowledge_base_id: knowledgeBaseId, document_id: documentId,
    document_version_id: versionId, document_name: 'generic-catalog.txt',
    source_page_start: 1, source_page_end: 1, item_key: key, name, category, category_key: categoryKey,
    parent_category_key: 'all-offers', category_aliases: [], aliases,
    description: `Approved description for ${name}`, price: 100, currency: 'USD',
    display_order: 0, attributes: [], relationships: {}, selection_rules: {},
  };
}

const premiumMale = catalogItem(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'premium-male', 'Premium Male', 'Screening Options',
  'screening-options', ['Premium Mail'],
);
const premiumFemale = catalogItem(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'premium-female', 'Premium Female', 'Screening Options',
  'screening-options',
);
const maleAddon = catalogItem(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'male-add-on', 'Male Add-on', 'Screening Options',
  'screening-options',
);
const femaleAddon = catalogItem(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'female-add-on', 'Female Add-on', 'Screening Options',
  'screening-options',
);
const platinum = catalogItem(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'platinum-plan', 'Platinum Plan', 'Master Plans',
  'master-plans',
);
const profile = {
  agent_usage: 'inbound',
  agent_settings: {
    knowledgeHighConfidence: 0.86,
    knowledgeClarificationConfidence: 0.64,
    knowledgeAmbiguityMargin: 0.06,
    knowledgeClarificationMessage: 'Did you mean {{candidates}}?',
  },
  knowledge_bases: [], workflows: [], conversations: [], faqs: [],
  catalog_items: [premiumMale, premiumFemale, maleAddon, femaleAddon, platinum],
};
const dependencies = {
  cache: { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } },
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [profile] }) }),
  embed: async () => { throw new Error('Local contextual routing must not call embeddings'); },
  search: async () => { throw new Error('Local contextual routing must not search vectors'); },
};
const baseInput = {
  agentId, usageDirection: 'inbound', language: 'en', routeHint: 'auto',
  currentStage: 'item_details', activeCategoryKey: 'screening-options',
  activeCategoryName: 'Screening Options',
  candidateItemKeys: ['premium-male', 'premium-female', 'male-add-on', 'female-add-on'],
};
const route = (query, overrides = {}) => routeKnowledgeQuery(
  { tenantId }, { ...baseInput, query, ...overrides }, dependencies,
);

const selectedFollowUp = await route('what is the price', {
  currentTopic: 'Premium Male', selectedCatalogItemId: premiumMale.id,
  selectedCatalogItemKey: premiumMale.item_key, selectedCatalogItemName: premiumMale.name,
  pendingQuestion: 'Do you want its price or details?',
});
assert.equal(selectedFollowUp.route, 'catalog');
assert.equal(selectedFollowUp.item.key, 'premium-male');
assert.equal(selectedFollowUp.retrieval.contextUsed, true);

const ambiguousChild = await route('female', {
  currentTopic: 'Screening Options', pendingQuestion: 'Premium or Add-on?',
});
assert.equal(ambiguousChild.route, 'clarification');
assert.match(ambiguousChild.content, /Premium Female/u);
assert.match(ambiguousChild.content, /Female Add-on/u);

const phoneticChild = await route('premium mail');
assert.equal(phoneticChild.route, 'catalog');
assert.equal(phoneticChild.item.key, 'premium-male');
assert.ok(['normalized', 'phonetic'].includes(phoneticChild.entityResolution.method));

const repeatActiveCategory = await route('again', {
  currentTopic: 'Screening Options', pendingQuestion: 'Which screening option?',
  selectedCatalogItemId: undefined, selectedCatalogItemKey: undefined, selectedCatalogItemName: undefined,
});
assert.equal(repeatActiveCategory.route, 'catalog');
assert.equal(repeatActiveCategory.category.key, 'screening-options');
assert.equal(repeatActiveCategory.retrieval.contextUsed, true);

const clearTopicChange = await route('Platinum Plan details');
assert.equal(clearTopicChange.route, 'catalog');
assert.equal(clearTopicChange.item.key, 'platinum-plan');
assert.equal(clearTopicChange.retrieval.contextUsed, false);

const unrelatedLongTopicChange = await route('I need help with a completely unrelated account access concern');
assert.equal(unrelatedLongTopicChange.route, 'none');

const schemaResult = runtimeKnowledgeQuerySchema.parse({
  ...baseInput, query: 'female', candidateItemKeys: ['premium-female', 'female-add-on'],
});
assert.equal(schemaResult.activeCategoryKey, 'screening-options');
assert.equal(schemaResult.candidateItemKeys.length, 2);

const samples = [];
for (let index = 0; index < 100; index += 1) {
  const startedAt = performance.now();
  await route(index % 2 ? 'what is the price' : 'again', {
    currentTopic: 'Premium Male', selectedCatalogItemKey: 'premium-male',
    selectedCatalogItemName: 'Premium Male',
  });
  samples.push(performance.now() - startedAt);
}
samples.sort((left, right) => left - right);
const p95Ms = samples[Math.floor(samples.length * 0.95)];
assert.ok(p95Ms < 50, `Contextual local retrieval p95 ${p95Ms}ms exceeded 50ms`);

console.log(JSON.stringify({
  task: 'Contextual hybrid retrieval',
  matching: ['exact', 'normalized', 'phonetic', 'semantic'],
  context: ['latestSentence', 'currentTopic', 'pendingQuestion', 'activeCategory', 'candidateItems'],
  specificChildPreferred: true,
  clearTopicChangeSupported: true,
  accumulatedContextSentToEmbeddingProvider: false,
  localP95Ms: Math.round(p95Ms * 1000) / 1000,
}, null, 2));
