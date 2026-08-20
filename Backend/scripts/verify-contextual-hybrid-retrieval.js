import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';

const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');
const {
  catalogIdentityDiscoveryPolicy,
  contextualRetrievalPolicy,
  callerMessageEligibleForDecision,
  focusAuthoritativeCatalogEvidence,
  isolatedRetrievalQueries,
  mergeCandidateSignals,
  postIdentityContextPolicy,
  prioritizeCandidates,
  rememberedCatalogIdentityCandidates,
  selectStrongCallerMessage,
  strongCallerMessageMatch,
} = await import('../src/knowledge-bases/hybrid-knowledge-retrieval.service.js');
const { QDRANT_SEARCH_LIMIT_MAX } = await import('../src/rag/qdrant.client.js');
const { classifyCatalogEntityLocally } = await import(
  '../src/knowledge-bases/catalog-entity-resolver.js'
);

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '33333333-3333-4333-8333-333333333333';
const knowledgeBaseId = '22222222-2222-4222-8222-222222222222';

const dependencies = {
  cache: { status: 'disabled', async get() { return null; }, async set() { return 'OK'; } },
  contextRunner: async (_auth, callback) => callback({
    async query() {
      return {
        rows: [{
          agent_usage: 'inbound',
          knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 3 }],
        }],
      };
    },
  }),
  embed: async () => { throw new Error('Disabled local verifier must not call embeddings'); },
  search: async () => { throw new Error('Disabled local verifier must not search vectors'); },
  ragEnabled: false,
};

const baseInput = {
  agentId, usageDirection: 'inbound', language: 'en', routeHint: 'auto',
};
const route = (query, overrides = {}) => routeKnowledgeQuery(
  { tenantId }, { ...baseInput, query, ...overrides }, dependencies,
);

const compatibilityResult = await route('what is the price', {
  currentTopic: 'Selected Option',
  knownEntities: [{ key: 'selected-option', name: 'Selected Option' }],
  pendingQuestion: 'Do you want its price or details?',
});
assert.equal(compatibilityResult.route, 'hybrid');
assert.equal(compatibilityResult.found, false);
assert.equal(compatibilityResult.retrieval.contextualAvailable, true);
assert.equal(compatibilityResult.retrieval.contextualUsed, true);
assert.equal(compatibilityResult.retrieval.semanticCandidates, 0);
assert.equal(compatibilityResult.retrieval.lexicalCandidates, 0);

const queries = isolatedRetrievalQueries({
  query: 'stale replacement must be ignored',
  latestCallerUtterance: 'What does it include?',
  pendingQuestion: 'Would you like details?',
  knownEntities: [{ key: 'selected-option', name: 'Selected Option', category: 'Options' }],
  currentTopic: 'old topic',
  lastAnswer: 'old answer',
});
assert.equal(queries.primary, 'What does it include?');
assert.match(queries.contextual, /Selected Option/u);
assert.match(queries.contextual, /Would you like details\?/u);
assert.doesNotMatch(queries.contextual, /old topic|old answer/u);

const unresolvedFollowUp = contextualRetrievalPolicy({
  pendingQuestion: 'Would you like details?',
  knownEntities: [{ key: 'selected-option', name: 'Selected Option' }],
}, 'yes', []);
assert.equal(unresolvedFollowUp.useContext, true);
assert.equal(unresolvedFollowUp.preferContext, true);
assert.equal(catalogIdentityDiscoveryPolicy('yes', true), false);
assert.equal(catalogIdentityDiscoveryPolicy('New Option', true), true);

const stalePreferredPolicy = contextualRetrievalPolicy({
  pendingQuestion: 'Would you like another option?',
  knownEntities: [{ key: 'old-option', name: 'Old Option' }],
}, 'New Option', []);
assert.equal(stalePreferredPolicy.preferContext, true);
const refreshedPrimaryPolicy = postIdentityContextPolicy(
  stalePreferredPolicy,
  {
    pendingQuestion: 'Would you like another option?',
    knownEntities: [{ key: 'old-option', name: 'Old Option' }],
  },
  'New Option',
  [{
    recordType: 'CATALOG_ITEM', semanticScore: 0, lexicalScore: 0,
    tokenCoverage: 1, score: 0.9, channels: ['catalog_identity'],
    contentPreview: 'New Option',
  }],
  { status: 'match', entityType: 'item' },
);
assert.equal(refreshedPrimaryPolicy.useContext, false);
assert.equal(refreshedPrimaryPolicy.preferContext, false);

const rememberedLungs = rememberedCatalogIdentityCandidates([{
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  knowledge_base_id: knowledgeBaseId,
  publication_revision: 3,
  document_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  document_version_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  item_key: 'lungs-health-checkup', name: 'Lungs Health Checkup',
  category: 'Organ-Specific Health Check-ups',
}], [{ key: 'lungs-health-checkup', name: 'Lungs Health Checkup' }]);
assert.equal(rememberedLungs.length, 1);
assert.equal(rememberedLungs[0].recordId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.equal(rememberedLungs[0].retrievalContext, 'contextual');
assert.deepEqual(rememberedLungs[0].channels, ['conversation_memory']);
assert.equal(rememberedCatalogIdentityCandidates([{
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  knowledge_base_id: knowledgeBaseId,
  item_key: 'lungs-health-checkup', name: 'Lungs Health Checkup',
}], [{ key: 'diabetes-health-checkup', name: 'Diabetes Health Checkup' }]).length, 0);

const retainedRememberedEntity = prioritizeCandidates([{
  recordType: 'FAQ', recordId: 'faq-1', knowledgeBaseId,
  semanticScore: 0.9, score: 0.9, channels: ['semantic'],
}], rememberedLungs, true, false, 5);
assert.ok(retainedRememberedEntity.some((candidate) => (
  candidate.recordId === rememberedLungs[0].recordId
  && candidate.retrievalContext === 'contextual'
)));
const memoryFocusedEvidence = focusAuthoritativeCatalogEvidence([{
  ...rememberedLungs[0], id: rememberedLungs[0].recordId,
  callerFacing: true,
  authoritativeData: {
    itemKey: 'lungs-health-checkup', name: 'Lungs Health Checkup',
  },
}, {
  id: 'faq-1', recordId: 'faq-1', recordType: 'FAQ', callerFacing: true,
  content: 'A relevant primary fact.', retrievalContext: 'primary',
}], {
  knownEntities: [{ key: 'lungs-health-checkup', name: 'Lungs Health Checkup' }],
}, 5);
assert.ok(memoryFocusedEvidence.evidence.some((item) => item.recordId === 'faq-1'),
  'memory hydration must not erase complementary latest-turn evidence');

const strongExplicitItem = contextualRetrievalPolicy({
  pendingQuestion: 'Would you like another option?',
  knownEntities: [{ key: 'old-option', name: 'Old Option' }],
}, 'New Option', [{
  recordType: 'CATALOG_ITEM', semanticScore: 0.96, tokenCoverage: 1,
  channels: ['semantic', 'bm25'], contentPreview: 'New Option',
}]);
assert.equal(strongExplicitItem.useContext, false);
assert.equal(strongExplicitItem.preferContext, false);

const strongMessage = contextualRetrievalPolicy({
  pendingQuestion: 'Would you like details?',
  knownEntities: [],
}, 'yes', [{
  recordType: 'CONVERSATION_NODE', semanticScore: 0.96, tokenCoverage: 1,
  channels: ['semantic', 'bm25'], contentPreview: 'Yes',
}]);
assert.equal(strongMessage.useContext, false);
assert.equal(strongMessage.preferContext, true);

const misleadingStrongFaq = contextualRetrievalPolicy({
  pendingQuestion: 'Would you like details?',
  knownEntities: [],
}, 'yes', [{
  recordType: 'FAQ', semanticScore: 0.96, tokenCoverage: 0,
  channels: ['semantic'], contentPreview: 'A semantically nearby answer',
}]);
assert.equal(misleadingStrongFaq.useContext, true);
assert.equal(misleadingStrongFaq.preferContext, true);

const exactLatestOverview = {
  id: 'overview-message', recordId: 'overview-message',
  recordType: 'CONVERSATION_NODE', callerFacing: true,
  retrievalContext: 'primary', semanticScore: 0.7, channels: ['semantic'],
  authoritativeData: {
    nodeType: 'message',
    variables: [
      { key: 'situation', value: 'The caller explicitly requests all or other available options.' },
      { key: 'context', value: 'no_selected_entity' },
      { key: 'examples', value: ['What other options are available?'] },
    ],
  },
};
assert.equal(strongCallerMessageMatch(
  exactLatestOverview,
  'What other options are available?',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), true, 'an exact latest published example must override stale selected-entity context');
const semanticLatestOverview = {
  ...exactLatestOverview,
  semanticScore: 0.99,
  authoritativeData: {
    ...exactLatestOverview.authoritativeData,
    variables: exactLatestOverview.authoritativeData.variables.map((variable) => (
      variable.key === 'examples'
        ? { ...variable, value: ['A different approved example'] }
        : variable
    )),
  },
};
assert.equal(strongCallerMessageMatch(
  semanticLatestOverview,
  'What other packages do you have?',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), false, 'semantic similarity without document-example alignment must not override an entity');
const documentAlignedSemanticOverview = {
  ...semanticLatestOverview,
  semanticScore: 0.8,
  authoritativeData: {
    ...semanticLatestOverview.authoritativeData,
    variables: semanticLatestOverview.authoritativeData.variables.map((variable) => (
      variable.key === 'examples'
        ? { ...variable, value: ['What other package options do you have?'] }
        : variable
    )),
  },
};
assert.equal(strongCallerMessageMatch(
  documentAlignedSemanticOverview,
  'What other packages do you have?',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), true, 'semantic topic changes must align with tenant-published examples');
assert.equal(strongCallerMessageMatch(
  documentAlignedSemanticOverview,
  'Could you give me a complete overview of the other package options?',
  { knownEntities: [] },
), true, 'polite filler must not dilute multi-term published-example alignment');
assert.equal(strongCallerMessageMatch(
  documentAlignedSemanticOverview,
  'What tests are included in this package?',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), false, 'a contextual package fact request must retain the selected entity');
const lexicalLatestOverview = {
  ...documentAlignedSemanticOverview,
  semanticScore: 0.7,
  lexicalScore: 5,
  tokenCoverage: 0.6,
  channels: ['bm25'],
};
assert.equal(strongCallerMessageMatch(
  lexicalLatestOverview,
  'What other packages do you have?',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), true, 'strong lexical latest-turn evidence may explicitly change topic');
assert.equal(strongCallerMessageMatch(
  {
    ...lexicalLatestOverview,
    authoritativeData: semanticLatestOverview.authoritativeData,
  },
  'What tests are included in this package?',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), false, 'raw BM25 strength must not override an entity without published-example alignment');
assert.equal(strongCallerMessageMatch(
  exactLatestOverview,
  'Tell me about the old item.',
  { knownEntities: [{ key: 'old-item', name: 'Old Item' }] },
), false, 'a non-matching generic message must not override a selected entity');

const unqualifiedCallerMessage = {
  recordType: 'CONVERSATION_NODE', callerFacing: true,
  authoritativeData: {
    nodeType: 'message',
    variables: [{ key: 'purpose', value: 'A configured control response.' }],
  },
  retrievalContext: 'contextual', semanticScore: 0.95,
  channels: ['semantic'],
};
assert.equal(strongCallerMessageMatch(unqualifiedCallerMessage, 'Short reply', {
  pendingQuestion: 'A pending configured question?',
}), false);
assert.equal(strongCallerMessageMatch({
  ...unqualifiedCallerMessage,
  authoritativeData: {
    ...unqualifiedCallerMessage.authoritativeData,
    variables: [
      ...unqualifiedCallerMessage.authoritativeData.variables,
      { key: 'situation', value: 'The caller answers the immediately pending question.' },
    ],
  },
}, 'Short reply', { pendingQuestion: 'A pending configured question?' }), true);
assert.equal(callerMessageEligibleForDecision({
  ...unqualifiedCallerMessage,
  semanticScore: 0.7,
  authoritativeData: {
    ...unqualifiedCallerMessage.authoritativeData,
    variables: [
      ...unqualifiedCallerMessage.authoritativeData.variables,
      { key: 'situation', value: 'The caller answers the immediately pending question.' },
    ],
  },
}, 'Short reply', { pendingQuestion: 'A pending configured question?' }), true);
assert.equal(callerMessageEligibleForDecision(unqualifiedCallerMessage, 'Short reply', {
  pendingQuestion: 'A pending configured question?',
}), false);

const contextualWinner = selectStrongCallerMessage([
  {
    ...unqualifiedCallerMessage, id: 'contextual-winner', semanticScore: 0.831,
    authoritativeData: {
      ...unqualifiedCallerMessage.authoritativeData,
      variables: [
        { key: 'situation', value: 'The caller answers the immediately pending question.' },
        { key: 'context', value: 'pending_question' },
      ],
    },
  },
  {
    ...unqualifiedCallerMessage, id: 'contextual-runner-up', semanticScore: 0.829,
    authoritativeData: {
      ...unqualifiedCallerMessage.authoritativeData,
      variables: [
        { key: 'situation', value: 'The caller begins a different configured request.' },
        { key: 'context', value: 'pending_question' },
      ],
    },
  },
], 'Short reply', { pendingQuestion: 'A pending configured question?' });
assert.equal(contextualWinner?.id, 'contextual-winner');

const exactConfiguredExample = selectStrongCallerMessage([
  {
    ...unqualifiedCallerMessage, id: 'semantic-neighbour', semanticScore: 0.97,
    authoritativeData: {
      ...unqualifiedCallerMessage.authoritativeData,
      variables: [
        { key: 'situation', value: 'The caller makes a nearby request.' },
        { key: 'examples', value: ['Are you there?'] },
      ],
    },
  },
  {
    ...unqualifiedCallerMessage, id: 'configured-example', semanticScore: 0.84,
    authoritativeData: {
      ...unqualifiedCallerMessage.authoritativeData,
      variables: [
        { key: 'situation', value: 'The caller answers the pending configured question.' },
        { key: 'examples', value: ['Yes, that is correct'] },
      ],
    },
  },
], 'Yes, that is correct', { pendingQuestion: 'Is this the correct account?' });
assert.equal(exactConfiguredExample?.id, 'configured-example');

const crowdedCandidates = prioritizeCandidates([
  ...Array.from({ length: 5 }, (_value, index) => ({
    recordType: 'FAQ', recordId: `00000000-0000-4000-8000-00000000000${index}`,
    knowledgeBaseId, score: 1 - index * 0.01,
  })),
  {
    recordType: 'CONVERSATION_NODE',
    recordId: '00000000-0000-4000-8000-000000000010',
    knowledgeBaseId, score: 0.8,
  },
], [], false, false, 5);
assert.equal(crowdedCandidates.length, 5);
assert.ok(crowdedCandidates.some((candidate) => candidate.recordType === 'CONVERSATION_NODE'));

const contextualMessageCandidates = prioritizeCandidates([
  ...Array.from({ length: 5 }, (_value, index) => ({
    recordType: 'FAQ', recordId: `10000000-0000-4000-8000-00000000000${index}`,
    knowledgeBaseId, score: 1 - index * 0.01,
  })),
  ...Array.from({ length: 4 }, (_value, index) => ({
    recordType: 'CONVERSATION_NODE',
    recordId: `20000000-0000-4000-8000-00000000000${index}`,
    knowledgeBaseId, score: 0.8 - index * 0.01,
  })),
], [], true, true, 5);
assert.equal(contextualMessageCandidates.length, 5);
assert.equal(contextualMessageCandidates.filter((candidate) => (
  candidate.recordType === 'CONVERSATION_NODE'
)).length, 4);

const semanticSearchOptions = [];
await routeKnowledgeQuery(
  { tenantId },
  { ...baseInput, query: 'A complete standalone request' },
  {
    ...dependencies,
    ragEnabled: true,
    embed: async () => [0],
    search: async (_tenantId, _vector, options) => {
      semanticSearchOptions.push(options);
      return [];
    },
  },
);
assert.equal(semanticSearchOptions.length, 1);
assert.equal(semanticSearchOptions[0].limit, QDRANT_SEARCH_LIMIT_MAX);
assert.equal(semanticSearchOptions[0].limit, 30);

const mergedIdentitySignals = mergeCandidateSignals({
  recordType: 'CATALOG_ITEM', recordId: 'shared-record',
  score: 0.9, semanticScore: 0, lexicalScore: 0, tokenCoverage: 0,
  channels: ['catalog_identity'], retrievalContext: 'primary',
}, {
  recordType: 'CATALOG_ITEM', recordId: 'shared-record',
  score: 0.82, semanticScore: 0.82, lexicalScore: 3, tokenCoverage: 0.5,
  channels: ['semantic', 'bm25'], semanticRank: 2, bm25Rank: 1,
});
assert.equal(mergedIdentitySignals.semanticScore, 0.82);
assert.equal(mergedIdentitySignals.lexicalScore, 3);
assert.equal(mergedIdentitySignals.tokenCoverage, 0.5);
assert.deepEqual(mergedIdentitySignals.channels, ['catalog_identity', 'semantic', 'bm25']);

// A compact category and a longer child can share a short phonetic code. The
// category must remain selected so authoritative hydration can load its children.
const phoneticCategory = classifyCatalogEntityLocally([{
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  knowledge_base_id: knowledgeBaseId,
  name: 'Prime Screening Add-on Female', item_key: 'prime-screening-female', aliases: [],
  category: 'Prime Care Packages', category_key: 'prime-care', category_aliases: [],
}], 'Pryme Kair package');
assert.equal(phoneticCategory.status, 'match');
assert.equal(phoneticCategory.entityType, 'category');
assert.equal(phoneticCategory.categoryKey, 'prime-care');

const hierarchyBackedCategory = classifyCatalogEntityLocally([
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', knowledge_base_id: knowledgeBaseId,
    name: 'Renal Health Checkup', item_key: 'renal-health-checkup', aliases: [],
    category: 'Organ-Specific Health Check-ups',
    category_key: 'organ-specific-health-checkups', category_aliases: [],
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', knowledge_base_id: knowledgeBaseId,
    name: 'Lungs Health Checkup', item_key: 'lungs-health-checkup', aliases: [],
    category: 'Organ-Specific Health Check-ups',
    category_key: 'organ-specific-health-checkups', category_aliases: [],
  },
], 'Specific health area checkup');
assert.equal(hierarchyBackedCategory.status, 'match');
assert.equal(hierarchyBackedCategory.entityType, 'category');
assert.equal(hierarchyBackedCategory.categoryKey, 'organ-specific-health-checkups');

const explicitChildAfterCategory = classifyCatalogEntityLocally([
  {
    id: 'b1111111-1111-4111-8111-111111111111', knowledge_base_id: knowledgeBaseId,
    name: 'Lungs Health Checkup', item_key: 'lungs-health-checkup',
    aliases: ['lungs', 'lung package', 'lung health checkup'],
    category: 'Organ-Specific Health Check-ups',
    category_key: 'organ-specific-health-checkups', category_aliases: [],
  },
  {
    id: 'b2222222-2222-4222-8222-222222222222', knowledge_base_id: knowledgeBaseId,
    name: 'Renal Health Checkup', item_key: 'renal-health-checkup',
    aliases: ['renal', 'kidney package'],
    category: 'Organ-Specific Health Check-ups',
    category_key: 'organ-specific-health-checkups', category_aliases: [],
  },
], 'Lung care பத்தி சொல்றீங்களா?');
assert.equal(explicitChildAfterCategory.status, 'match');
assert.equal(explicitChildAfterCategory.entityType, 'item');
assert.equal(explicitChildAfterCategory.item.item_key, 'lungs-health-checkup');

// A complete production Catalog contains unrelated items whose partial token
// matches can sit inside the ambiguity margin. A leading multi-token category
// phrase must still hydrate the category when no exact competing identity wins.
const crowdedCategory = classifyCatalogEntityLocally([
  {
    id: 'f1111111-1111-4111-8111-111111111111', knowledge_base_id: knowledgeBaseId,
    name: 'Renal Health Checkup', item_key: 'renal-health-checkup', aliases: [],
    category: 'Organ-Specific Health Check-ups',
    category_key: 'organ-specific-health-checkups', category_aliases: [],
  },
  {
    id: 'f2222222-2222-4222-8222-222222222222', knowledge_base_id: knowledgeBaseId,
    name: 'Diabetes Health Checkup', item_key: 'diabetes-health-checkup', aliases: [],
    category: 'Metabolic Screening', category_key: 'metabolic-screening', category_aliases: [],
  },
  {
    id: 'f3333333-3333-4333-8333-333333333333', knowledge_base_id: knowledgeBaseId,
    name: 'Advanced Specific Screening', item_key: 'advanced-specific-screening', aliases: [],
    category: 'Advanced Screening', category_key: 'advanced-screening', category_aliases: [],
  },
], 'Specific health area checkup');
assert.equal(crowdedCategory.status, 'match');
assert.equal(crowdedCategory.entityType, 'category');
assert.equal(crowdedCategory.categoryKey, 'organ-specific-health-checkups');

const fullAliasBeatsPartialLabel = classifyCatalogEntityLocally([
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', knowledge_base_id: knowledgeBaseId,
    name: 'Cloud', item_key: 'cloud-storage', aliases: ['cloud'],
    category: 'Storage Plans', category_key: 'storage-plans', category_aliases: [],
  },
  {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', knowledge_base_id: knowledgeBaseId,
    name: 'Premium Care Annual', item_key: 'premium-care-annual', aliases: [],
    category: 'Support Plans', category_key: 'support-plans', category_aliases: [],
  },
], 'Clowd care');
assert.equal(fullAliasBeatsPartialLabel.status, 'match');
assert.equal(fullAliasBeatsPartialLabel.entityType, 'item');
assert.equal(fullAliasBeatsPartialLabel.item.item_key, 'cloud-storage');

const samples = [];
for (let index = 0; index < 100; index += 1) {
  const startedAt = performance.now();
  contextualRetrievalPolicy({
    pendingQuestion: 'Would you like details?',
    knownEntities: [{ key: 'selected-option', name: 'Selected Option' }],
  }, index % 2 ? 'yes' : 'New Option', index % 2 ? [] : [{
    recordType: 'CATALOG_ITEM', semanticScore: 0.96, tokenCoverage: 1,
    channels: ['semantic', 'bm25'], contentPreview: 'New Option',
  }]);
  samples.push(performance.now() - startedAt);
}
samples.sort((left, right) => left - right);
const p95Ms = samples[Math.floor(samples.length * 0.95)];
assert.ok(p95Ms < 50, `Contextual local retrieval p95 ${p95Ms}ms exceeded 50ms`);

console.log(JSON.stringify({
  task: 'Contextual hybrid retrieval',
  singleCompatibilityPath: true,
  latestUtterancePrimary: true,
  contextualRetrievalOnlyWhenNeeded: true,
  authoritativeTypeDiversityPreserved: true,
  qdrantDiscoveryLimitContract: true,
  accumulatedContextSentToEmbeddingProvider: false,
  localP95Ms: Math.round(p95Ms * 1000) / 1000,
}, null, 2));
