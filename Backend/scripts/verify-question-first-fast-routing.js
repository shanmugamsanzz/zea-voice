import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.RAG_ENABLED = 'true';
const { routeKnowledgeQuery } = await import('../src/knowledge-bases/knowledge-runtime.service.js');

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const versionId = '55555555-5555-4555-8555-555555555555';

const record = (id) => ({
  id, knowledge_base_id: knowledgeBaseId, document_id: documentId,
  document_version_id: versionId, document_name: 'tenant-document.txt',
  source_page_start: 1, source_page_end: 1,
});

const profile = {
  agent_usage: 'both',
  agent_settings: { parallelHybridRetrievalEnabled: true },
  knowledge_bases: [{ id: knowledgeBaseId, publicationRevision: 1, priority: 1, semanticReady: true }],
  workflows: [{
    ...record('66666666-6666-4666-8666-666666666666'),
    name: 'safe_action', intent: 'safe_action', priority: 1,
    conditions: { triggerPhrases: ['perform safe action'], matchMode: 'exact' },
    action_type: 'respond', action_config: { responseMode: 'exact' },
    response_template: 'Approved action response.',
  }],
  conversations: [{
    ...record('77777777-7777-4777-8777-777777777777'),
    flow_key: 'main', node_key: 'saved_stage', node_type: 'message', language: 'en',
    sequence_order: 1, is_entry: false, content: 'Saved stage continuation.', variables: [], transitions: [],
  }],
  catalog_items: [],
  faqs: [{
    ...record('88888888-8888-4888-8888-888888888888'),
    question: 'where are you calling from', answer: 'Approved organization answer.', language: 'en',
  }],
};

let embeddingCalls = 0;
let searchCalls = 0;
const dependencies = {
  cache: null,
  contextRunner: async (_auth, run) => run({ query: async () => ({ rows: [profile] }) }),
  embed: async () => { embeddingCalls += 1; await new Promise((resolve) => setTimeout(resolve, 100)); return [0.1]; },
  search: async () => { searchCalls += 1; return []; },
};
const input = (query) => ({
  agentId, query, usageDirection: 'inbound', language: 'en', routeHint: 'auto', currentStage: 'saved_stage',
});

const workflowStarted = performance.now();
const workflow = await routeKnowledgeQuery({ tenantId }, input('perform safe action'), dependencies);
const workflowMs = performance.now() - workflowStarted;
assert.equal(workflow.route, 'workflow');
assert.equal(workflow.content, 'Approved action response.');
assert.equal(workflow.fastPath.skippedEmbedding, true);
assert.equal(workflow.fastPath.skippedLlm, true);
assert.ok(workflow.fastPath.routingDurationMs <= 20, `Workflow routing took ${workflow.fastPath.routingDurationMs}ms`);

const faqStarted = performance.now();
const faq = await routeKnowledgeQuery({ tenantId }, input('WHERE are you calling from?'), dependencies);
const faqMs = performance.now() - faqStarted;
assert.equal(faq.route, 'faq');
assert.equal(faq.content, 'Approved organization answer.');
assert.equal(faq.directAnswer.approved, true);
assert.ok(faq.fastPath.routingDurationMs <= 20, `FAQ routing took ${faq.fastPath.routingDurationMs}ms`);
assert.equal(embeddingCalls, 0);
assert.equal(searchCalls, 0);

console.log(JSON.stringify({
  task: 'question-first-fast-routing',
  workflowMs: Math.round(workflowMs * 1000) / 1000,
  faqMs: Math.round(faqMs * 1000) / 1000,
  embeddingCalls,
  searchCalls,
  stageIsContinuationOnly: true,
}, null, 2));
