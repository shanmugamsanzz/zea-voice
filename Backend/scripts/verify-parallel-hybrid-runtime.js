import assert from 'node:assert/strict';

process.env.RAG_ENABLED = 'true';
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const profile = {
  agent_usage: 'both',
  agent_settings: {
    parallelHybridRetrievalEnabled: true,
    knowledgeHighConfidence: 0.86,
    knowledgeClarificationConfidence: 0.64,
    knowledgeAmbiguityMargin: 0.06,
  },
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 1, priority: 1, semanticReady: true }],
  workflows: [{
    id: '55555555-5555-4555-8555-555555555555', knowledge_base_id: knowledgeBaseId,
    document_id: documentId, document_version_id: '66666666-6666-4666-8666-666666666666',
    document_name: 'workflow.txt', source_page_start: 1, source_page_end: 1,
    name: 'configured_action', intent: 'configured_action', priority: 10,
    conditions: { triggerPhrases: ['start configured action'], matchMode: 'exact', fromStages: ['current-stage'] },
    action_type: 'respond', action_config: { responseMode: 'exact' },
    response_template: 'Approved exact action response.',
  }],
  conversations: [{
    id: '77777777-7777-4777-8777-777777777777', knowledge_base_id: knowledgeBaseId,
    document_id: documentId, document_version_id: '88888888-8888-4888-8888-888888888888',
    document_name: 'script.txt', source_page_start: 1, source_page_end: 1,
    flow_key: 'main', node_key: 'current-stage', node_type: 'message', language: 'en',
    sequence_order: 0, is_entry: false, content: 'Approved stage wording.', variables: [], transitions: [],
  }],
  catalog_items: [],
  faqs: [{
    id: '99999999-9999-4999-8999-999999999999', knowledge_base_id: knowledgeBaseId,
    document_id: documentId, document_version_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    document_name: 'faq.txt', source_page_start: 1, source_page_end: 1,
    question: 'start configured action', answer: 'Approved FAQ answer.', language: 'en',
  }],
};
let embeddingCalls = 0;
let searchCalls = 0;
const result = await routeKnowledgeQuery({ tenantId, workspaceId: null, userId: null, role: 'COMPANY_DEVELOPER' }, {
  agentId, query: 'start configured action', usageDirection: 'inbound', language: 'en',
  routeHint: 'auto', currentStage: 'current-stage',
}, {
  cache: null,
  contextRunner: async (_auth, run) => run({ query: async () => ({ rows: [profile] }) }),
  embed: async () => { embeddingCalls += 1; return [0.1, 0.2]; },
  search: async (_tenant, _vector, options) => {
    searchCalls += 1;
    if (options.recordTypes?.includes('WORKFLOW_RULE')) return [];
    return [{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', score: 0.91,
      payload: {
        tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 1,
        agent_usage: 'BOTH', record_type: 'KNOWLEDGE_CHUNK', content: 'Approved general information.',
        document_id: documentId, page_number: 1,
      },
    }];
  },
});

assert.equal(result.route, 'workflow');
assert.equal(result.content, 'Approved exact action response.');
assert.equal(result.fastPath.type, 'deterministic_workflow');
assert.equal(result.fastPath.skippedEmbedding, true);
assert.equal(embeddingCalls, 0);
assert.equal(searchCalls, 0);

const parallelResult = await routeKnowledgeQuery(
  { tenantId, workspaceId: null, userId: null, role: 'COMPANY_DEVELOPER' },
  {
    agentId, query: 'approved general information', usageDirection: 'inbound', language: 'en',
    routeHint: 'auto', currentStage: 'current-stage',
  },
  {
    cache: null,
    contextRunner: async (_auth, run) => run({ query: async () => ({ rows: [profile] }) }),
    embed: async () => { embeddingCalls += 1; return [0.1, 0.2]; },
    search: async (_tenant, _vector, options) => {
      searchCalls += 1;
      if (options.recordTypes?.includes('WORKFLOW_RULE')) return [];
      return [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', score: 0.91,
        payload: {
          tenant_id: tenantId, knowledge_base_id: knowledgeBaseId, publication_revision: 1,
          agent_usage: 'BOTH', record_type: 'KNOWLEDGE_CHUNK', content: 'Approved general information.',
          document_id: documentId, page_number: 1,
        },
      }];
    },
  },
);
assert.ok(parallelResult.rankedEvidence.length >= 2);
assert.equal(parallelResult.rankedEvidence[0].route, 'semantic');
assert.ok(parallelResult.rankedEvidence.some((entry) => entry.route === 'conversation'));
assert.equal(embeddingCalls, 1);
assert.ok(searchCalls >= 2);
assert.equal(parallelResult.retrieval.channelFailures.length, 0);

console.log(JSON.stringify({
  enabled: true,
  selectedRoute: result.route,
  fastPath: result.fastPath.type,
  rankedRoutes: parallelResult.rankedEvidence.map((entry) => entry.route),
  sharedEmbeddingCalls: embeddingCalls,
  vectorSearchCalls: searchCalls,
  channelFailures: parallelResult.retrieval.channelFailures.length,
}, null, 2));
