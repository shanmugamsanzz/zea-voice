import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.RAG_ENABLED = 'false';

const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');
const {
  contextualRetrievalPolicy,
  isolatedRetrievalQueries,
} = await import('../src/knowledge-bases/hybrid-knowledge-retrieval.service.js');
const { QDRANT_SEARCH_LIMIT_MAX } = await import('../src/rag/qdrant.client.js');

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
assert.ok(semanticSearchOptions[0].limit <= 10);

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
  qdrantDiscoveryLimitContract: true,
  accumulatedContextSentToEmbeddingProvider: false,
  localP95Ms: Math.round(p95Ms * 1000) / 1000,
}, null, 2));
