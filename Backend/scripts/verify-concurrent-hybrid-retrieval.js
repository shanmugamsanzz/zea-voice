import assert from 'node:assert/strict';

process.env.RAG_ENABLED = 'true';
process.env.RAG_RUNTIME_SEMANTIC_DEADLINE_MS = '125';
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555';
const source = {
  knowledge_base_id: knowledgeBaseId,
  document_id: documentId,
  document_version_id: versionId,
  document_name: 'tenant-document.txt',
  source_page_start: 1,
  source_page_end: 1,
};
const profile = {
  agent_usage: 'both',
  agent_settings: {
    knowledgeHighConfidence: 0.86,
    knowledgeClarificationConfidence: 0.64,
    knowledgeAmbiguityMargin: 0.06,
  },
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 1, priority: 1, semanticReady: true }],
  workflows: [{
    ...source,
    id: '66666666-6666-4666-8666-666666666666',
    name: 'configured_cancellation', intent: 'configured_cancellation', priority: 10,
    conditions: { triggerPhrases: ['cancel subscription'], matchMode: 'any_phrase' },
    action_type: 'respond', action_config: { responseMode: 'exact' },
    response_template: 'Approved cancellation response.',
  }],
  catalog_items: [{
    ...source,
    id: '77777777-7777-4777-8777-777777777777', item_key: 'premium-plan',
    name: 'Premium Plan', category: 'Plans', category_key: 'plans', aliases: ['premium'],
    category_aliases: [], relationships: {}, description: 'Premium account plan.',
    price: 100, currency: 'INR', attributes: [], display_order: 1,
  }],
  conversations: [{
    ...source,
    id: '88888888-8888-4888-8888-888888888888', flow_key: 'main', node_key: 'saved-stage',
    node_type: 'message', language: 'en', sequence_order: 1, is_entry: false,
    content: 'Continue account setup.', variables: [], transitions: [],
  }],
  faqs: [{
    ...source,
    id: '99999999-9999-4999-8999-999999999999',
    question: 'What time do you open?', answer: 'We open at the configured time.', language: 'en',
  }],
  general_knowledge: [{
    ...source,
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chunk_index: 0,
    source_heading: 'Location', content: 'The branch is located downtown.',
  }],
};

let embeddingCalls = 0;
let vectorSearchCalls = 0;
const result = await routeKnowledgeQuery(
  { tenantId, workspaceId: null, userId: null, role: 'COMPANY_DEVELOPER' },
  {
    agentId, query: 'branch located', usageDirection: 'inbound', language: 'en',
    routeHint: 'auto', currentStage: 'saved-stage', detectedIntent: { intent: 'side_question' },
  },
  {
    cache: null,
    contextRunner: async (_auth, run) => run({ query: async () => ({ rows: [profile] }) }),
    embed: async () => {
      embeddingCalls += 1;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      });
      return [0.1, 0.2];
    },
    search: async () => { vectorSearchCalls += 1; return []; },
  },
);

assert.equal(result.route, 'lexical');
assert.equal(result.content, 'The branch is located downtown.');
assert.equal(result.lexical.cachedIndex, true);
assert.equal(result.retrieval.usedCachedDocumentIndex, true);
assert.equal(result.retrieval.semanticDeadlineMs, 125);
assert.ok(result.retrieval.parallelDurationMs <= 150, `retrieval took ${result.retrieval.parallelDurationMs}ms`);
assert.equal(embeddingCalls, 1, 'semantic channels must share one embedding request');
assert.equal(vectorSearchCalls, 0, 'a slow embedding must not reach vector search after the response deadline');
for (const channel of [
  'catalog_alias_hierarchy', 'catalog_fuzzy_phonetic', 'workflow_strong',
  'workflow_fuzzy_phonetic', 'lexical_bm25', 'conversation_script', 'faq_search',
  'general_knowledge', 'live_state_context', 'workflow_semantic', 'catalog_semantic',
  'document_semantic',
]) assert.ok(result.retrieval.channelsStarted.includes(channel), `${channel} did not start`);
assert.ok(result.retrieval.channelFailures.some((failure) => failure.code === 'RETRIEVAL_CHANNEL_DEADLINE'));

console.log(JSON.stringify({
  task: 'concurrent-hybrid-retrieval',
  selectedRoute: result.route,
  retrievalMs: result.retrieval.parallelDurationMs,
  semanticDeadlineMs: result.retrieval.semanticDeadlineMs,
  embeddingCalls,
  vectorSearchCalls,
  channelsStarted: result.retrieval.channelsStarted.length,
  deadlineChannels: result.retrieval.channelFailures
    .filter((failure) => failure.code === 'RETRIEVAL_CHANNEL_DEADLINE')
    .map((failure) => failure.channel),
}, null, 2));
