import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';
process.env.B2_S3_ENDPOINT ??= 'https://s3.example.invalid';
process.env.B2_BUCKET ??= 'test-bucket';
process.env.B2_BUCKET_ID ??= 'test-bucket-id';
process.env.B2_KEY_ID ??= 'test-key-id';
process.env.B2_APPLICATION_KEY ??= 'test-application-key';

const { classifyCatalogEntityLocally } = await import('../src/knowledge-bases/catalog-entity-resolver.js');
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';

function item(id, name, aliases, tenantMarker) {
  return {
    id, knowledge_base_id: tenantMarker, document_id: `${id.slice(0, -1)}1`,
    document_version_id: `${id.slice(0, -1)}2`, document_name: 'catalog.txt',
    source_page_start: 1, source_page_end: 1, item_key: name.toLowerCase().replace(/\s+/gu, '-'),
    name, category: 'Service Options', aliases, description: `${tenantMarker} approved description`,
    price: 999, currency: 'INR', display_order: 0, attributes: [],
  };
}

const itemA = item(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0', 'Lungs Health Checkup',
  ['Lung Check', 'நுரையீரல் பரிசோதனை', 'Lungs check pannunga'], tenantA,
);
const itemB = item(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0', 'Tenant B Private Plan',
  ['private option'], tenantB,
);
const workflow = {
  id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc0', knowledge_base_id: tenantA,
  document_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  document_version_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', document_name: 'workflow.txt',
  source_page_start: 1, source_page_end: 1, name: 'available_options', intent: 'available_options',
  priority: 1, conditions: { triggerPhrases: ['what options are available', 'என்ன options இருக்கு'], matchMode: 'any_phrase' },
  action_type: 'respond', action_config: { responseMode: 'exact' }, response_template: 'Approved exact workflow answer.',
};

const defaultSettings = {
  knowledgeHighConfidence: 0.86,
  knowledgeClarificationConfidence: 0.64,
  knowledgeAmbiguityMargin: 0.06,
  knowledgeClarificationMessage: 'நீங்க சொன்னது clearஆ கேக்கலங்க. {{candidates}} இதுல எது?',
};
const profiles = {
  [tenantA]: {
    agent_usage: 'inbound', agent_settings: defaultSettings,
    knowledge_bases: [], workflows: [workflow], conversations: [], catalog_items: [itemA], faqs: [],
  },
  [tenantB]: {
    agent_usage: 'inbound', agent_settings: defaultSettings,
    knowledge_bases: [], workflows: [], conversations: [], catalog_items: [itemB], faqs: [],
  },
};
const cache = { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } };
const dependencies = {
  cache,
  contextRunner: async (auth, callback) => callback({
    query: async () => ({ rows: [profiles[auth.tenantId]] }),
  }),
  embed: async () => { throw new Error('Deterministic routing must not call embeddings'); },
  search: async () => { throw new Error('Deterministic routing must not search vectors'); },
};
const input = (query, overrides = {}) => ({
  agentId, query, usageDirection: 'inbound', language: 'en', routeHint: 'auto', ...overrides,
});

for (const [query, expectedMethod] of [
  ['Lungs Health Checkup', 'normalized'],
  ['நுரையீரல் பரிசோதனை', 'normalized'],
  ['Lungs check pannunga', 'normalized'],
  ['Lunch package', 'phonetic'],
]) {
  const result = await routeKnowledgeQuery({ tenantId: tenantA }, input(query), dependencies);
  assert.equal(result.route, 'catalog', `${query} should resolve to an approved Catalog item`);
  assert.equal(result.item.name, itemA.name);
  assert.equal(result.entityResolution.method, expectedMethod);
}

const exactWorkflow = await routeKnowledgeQuery(
  { tenantId: tenantA }, input('என்ன options இருக்கு', { language: 'ta' }), dependencies,
);
assert.equal(exactWorkflow.route, 'workflow');
assert.equal(exactWorkflow.content, 'Approved exact workflow answer.');
assert.equal(exactWorkflow.workflow.exactResponse, true);
assert.equal(exactWorkflow.workflow.confidence, 1);

const uncertainProfile = {
  ...profiles[tenantA],
  agent_settings: { ...defaultSettings, knowledgeHighConfidence: 0.95 },
};
const uncertain = await routeKnowledgeQuery({ tenantId: tenantA }, input('Lunch package'), {
  ...dependencies,
  contextRunner: async (_auth, callback) => callback({ query: async () => ({ rows: [uncertainProfile] }) }),
});
assert.equal(uncertain.route, 'clarification');
assert.match(uncertain.content, /Lungs Health Checkup/u);
assert.equal(uncertain.clarification.reason, 'low_confidence');

const unrelated = await routeKnowledgeQuery({ tenantId: tenantA }, input('weather tomorrow'), dependencies);
assert.equal(unrelated.route, 'none');
assert.equal(unrelated.found, false);

const isolated = await routeKnowledgeQuery({ tenantId: tenantB }, input('private option'), dependencies);
assert.equal(isolated.item.name, itemB.name);
assert.doesNotMatch(isolated.content, /Lungs/u);

assert.equal(classifyCatalogEntityLocally([itemA], 'totally unrelated').status, 'none');
const measurements = [];
for (let index = 0; index < 250; index += 1) {
  const startedAt = performance.now();
  classifyCatalogEntityLocally([itemA, itemB], index % 2 ? 'Lunch package' : 'நுரையீரல் பரிசோதனை');
  measurements.push(performance.now() - startedAt);
}
measurements.sort((left, right) => left - right);
const p95Ms = measurements[Math.floor(measurements.length * 0.95)];
assert.ok(p95Ms < 1000, `Local confidence routing p95 must be under one second; received ${p95Ms}ms`);

console.log(JSON.stringify({
  task: 'Knowledge confidence routing and verification',
  highConfidenceRoutes: ['workflow', 'catalog'],
  languages: ['Tamil', 'Tanglish', 'English'],
  sttMistakeVerified: 'Lunch -> Lungs',
  uncertainRoute: uncertain.route,
  unrelatedRoute: unrelated.route,
  tenantIsolation: true,
  localP95Ms: Math.round(p95Ms * 1000) / 1000,
}, null, 2));
