import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';

const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');
const {
  contextualRetrievalPolicy,
  callerMessageEligibleForDecision,
  isolatedRetrievalQueries,
  prioritizeCandidates,
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
