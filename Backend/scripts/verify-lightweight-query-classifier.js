import assert from 'node:assert/strict';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import { resolvePublishedEntityRoute } from '../src/knowledge-engine/entity-route-resolver.js';
import {
  classifyKnowledgeQuery,
  knowledgeQueryClasses,
  knowledgeSearchIndexes,
} from '../src/knowledge-engine/query-classifier.js';

const tenantId = '50000000-0000-4000-8000-000000000001';
const agentId = '50000000-0000-4000-8000-000000000002';
const callId = '50000000-0000-4000-8000-000000000003';
const job = {
  tenant_id: tenantId,
  knowledge_base_id: '50000000-0000-4000-8000-000000000004',
  targetRevision: 1,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [agentId],
};

function record(index, type, value) {
  return {
    record_id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    record_type: type,
    document_id: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    document_version_id: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    usage_direction: 'both', language: 'mul', source_page_start: 1,
    entity_category_aliases: [], ...value,
  };
}

const alpha = record(1, 'catalog_item', {
  question: 'Alpha choice', answer: 'Alpha is available.', content: 'Alpha is available.',
  entity_name: 'Alpha choice', entity_category: 'Choices', entity_aliases: ['alpha'],
  entity_metadata: { itemKey: 'alpha', categoryKey: 'choices' },
});
const beta = record(2, 'catalog_item', {
  question: 'Beta choice', answer: 'Beta is available.', content: 'Beta is available.',
  entity_name: 'Beta choice', entity_category: 'Choices', entity_aliases: ['beta'],
  entity_metadata: { itemKey: 'beta', categoryKey: 'choices' },
});
const faq = record(3, 'faq', {
  question: 'Published detail question', answer: 'Published detail answer.', content: 'Published detail answer.',
  entity_aliases: ['detail phrase'], entity_metadata: { intentClass: 'DETAILS_OR_PRICE' },
});
const safety = record(4, 'workflow_rule', {
  question: 'priority safety', answer: 'Use the published safety response.', content: 'Safety workflow.',
  entity_name: 'priority safety', entity_category: 'safety', entity_aliases: ['priority phrase'],
  entity_metadata: {
    conditions: { examples: ['priority phrase'], intentClass: 'SAFETY_EMERGENCY' },
    actionType: 'respond', actionConfig: { responseMode: 'exact' }, priority: 1000,
  },
});
const control = record(5, 'workflow_rule', {
  question: 'call control', answer: 'Use the published call-control response.', content: 'Call control workflow.',
  entity_name: 'call control', entity_category: 'control', entity_aliases: ['control phrase', 'priority phrase'],
  entity_metadata: {
    conditions: { examples: ['control phrase', 'priority phrase'], intentClass: 'CALL_CONTROL' },
    actionType: 'respond', actionConfig: { responseMode: 'exact' }, priority: 900,
  },
});
const action = record(6, 'workflow_rule', {
  question: 'perform action', answer: 'I can start the configured action.', content: 'Configured workflow.',
  entity_name: 'perform action', entity_category: 'action', entity_aliases: ['action phrase'],
  entity_metadata: {
    conditions: { examples: ['action phrase'], intentClass: 'ACTION_TOOL_REQUEST' },
    actionType: 'configured_tool',
    actionConfig: {
      responseMode: 'instruction', toolIdentifier: 'tenant_action',
      requiresCatalogItem: true, scenarioTargetItemKey: 'alpha',
    },
  },
});
const acknowledgement = record(7, 'conversation_node', {
  question: 'acknowledgement', answer: 'Published acknowledgement.', content: 'Published acknowledgement.',
  entity_name: 'acknowledgement', entity_category: 'main', entity_aliases: ['ack phrase'],
  entity_metadata: { intentClass: 'ACKNOWLEDGEMENT' },
});

const bundle = buildPublicationIndexes(job, [alpha, beta, faq, safety, control, action, acknowledgement]);

function classify(utterance, { memory = {}, requestedFacts = [] } = {}) {
  const input = createKnowledgeEngineInput({
    tenantId, agentId, callId, utterance, memory, requestedFacts,
  });
  return classifyKnowledgeQuery(input, resolvePublishedEntityRoute(input, bundle));
}

let classification = classify('priority phrase');
assert.equal(classification.intentClass, knowledgeQueryClasses.SAFETY_EMERGENCY,
  'Safety must outrank a competing call-control route');
assert.deepEqual(classification.retrievalPlan.indexes, [
  knowledgeSearchIndexes.WORKFLOW, knowledgeSearchIndexes.CONVERSATION,
]);

classification = classify('control phrase');
assert.equal(classification.intentClass, knowledgeQueryClasses.CALL_CONTROL);

classification = classify('action phrase');
assert.equal(classification.intentClass, knowledgeQueryClasses.ACTION_TOOL_REQUEST);
assert.ok(classification.retrievalPlan.indexes.includes(knowledgeSearchIndexes.WORKFLOW));

classification = classify('clarification value', {
  memory: { pendingClarification: { kind: 'ambiguity', candidates: ['alpha', 'beta'] } },
});
assert.equal(classification.intentClass, knowledgeQueryClasses.CLARIFICATION_ANSWER);

classification = classify('ack phrase');
assert.equal(classification.intentClass, knowledgeQueryClasses.ACKNOWLEDGEMENT);
assert.deepEqual(classification.retrievalPlan.indexes, [knowledgeSearchIndexes.CONVERSATION]);

classification = classify('Choices');
assert.equal(classification.intentClass, knowledgeQueryClasses.CATEGORY_OVERVIEW);

classification = classify('alpha and beta');
assert.equal(classification.intentClass, knowledgeQueryClasses.COMPARISON_COMPLEX);
assert.equal(classification.retrievalPlan.useSemantic, true);

classification = classify('detail phrase');
assert.equal(classification.intentClass, knowledgeQueryClasses.DETAILS_OR_PRICE);
assert.deepEqual(classification.retrievalPlan.indexes, [
  knowledgeSearchIndexes.CATALOG, knowledgeSearchIndexes.FAQ, knowledgeSearchIndexes.BM25,
]);

classification = classify('alpha');
assert.equal(classification.intentClass, knowledgeQueryClasses.KNOWN_INFORMATION);
assert.ok(classification.retrievalPlan.indexes.includes(knowledgeSearchIndexes.ANSWER_CARD));

classification = classify('beta', {
  memory: {
    activeEntity: { recordId: alpha.record_id, key: 'alpha' },
    pendingClarification: { kind: 'ambiguity', candidates: ['alpha', 'beta'] },
  },
});
assert.equal(classification.intentClass, knowledgeQueryClasses.KNOWN_INFORMATION,
  'A new high-confidence explicit entity must replace stale memory and clarification');
assert.equal(classification.candidate.itemKey, 'beta');

classification = classify('fact request', {
  memory: { activeEntity: { recordId: alpha.record_id, key: 'alpha' } },
  requestedFacts: ['tenant-defined-fact'],
});
assert.equal(classification.intentClass, knowledgeQueryClasses.DETAILS_OR_PRICE);

classification = classify('unmapped utterance');
assert.equal(classification.intentClass, knowledgeQueryClasses.UNKNOWN);
assert.deepEqual(classification.retrievalPlan.indexes, [
  knowledgeSearchIndexes.FAQ, knowledgeSearchIndexes.CONVERSATION,
  knowledgeSearchIndexes.GENERAL, knowledgeSearchIndexes.BM25, knowledgeSearchIndexes.SEMANTIC,
]);

classification = classifyKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'location question',
}), {
  tenantId, agentId, callId, action: 'CONFIRM', score: 0.72,
  routingCandidates: [{
    recordId: acknowledgement.record_id, recordType: 'CONVERSATION_NODE',
    entityType: 'ROUTE', score: 0.72, method: 'fuzzy', explicit: true,
    signals: [{ method: 'fuzzy', score: 0.72, phrase: 'generic conversation', explicit: true }],
  }],
});
assert.equal(classification.intentClass, knowledgeQueryClasses.UNKNOWN,
  'A weak generic Conversation match must fall through to General/BM25/semantic retrieval');
assert.ok(classification.retrievalPlan.indexes.includes(knowledgeSearchIndexes.GENERAL));
assert.equal(classification.requiresConfirmation, false,
  'An ineligible weak route must not force clarification before targeted retrieval');

classification = classify('tenant field value', {
  memory: { activeTool: { name: 'tenant_action', authorizationRecordId: action.record_id } },
});
assert.equal(classification.intentClass, knowledgeQueryClasses.ACTION_TOOL_REQUEST,
  'An active tool field response must remain in the authorized tool workflow');

classification = classifyKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'ordinary chest pain',
}), {
  tenantId, agentId, callId, action: 'CONFIRM', score: 0.78,
  routingCandidates: [{
    recordId: safety.record_id, recordType: 'WORKFLOW_RULE', entityType: 'ROUTE',
    intentClass: 'SAFETY_EMERGENCY', score: 0.78, method: 'fuzzy', explicit: true,
    signals: [{ method: 'fuzzy', score: 0.78, phrase: 'severe chest pain', explicit: true }],
  }],
});
assert.equal(classification.intentClass, knowledgeQueryClasses.UNKNOWN,
  'Emergency routing must not activate from fuzzy similarity without an explicit severe trigger');

const workflowExtraction = processExtractedCategory('workflow_rules', {
  fullText: '', pages: [{ pageNumber: 1, lines: [
    'RULE: urgent_route',
    'MATCH: tenant-owned phrase',
    'INTENT_CLASS: SAFETY_EMERGENCY',
    'RESPONSE_MODE: exact',
    'RESPONSE: Tenant-approved response.',
  ] }],
});
assert.equal(workflowExtraction.records[0].conditions.intentClass, 'SAFETY_EMERGENCY');
assert.equal(workflowExtraction.errors.length, 0);

const faqExtraction = processExtractedCategory('faq', {
  fullText: '', pages: [{ pageNumber: 1, lines: [
    'QUESTION: tenant detail question',
    'ALIASES: tenant detail alias',
    'INTENT_CLASS: DETAILS_OR_PRICE',
    'ANSWER: Tenant-approved detail.',
  ] }],
});
assert.equal(faqExtraction.records[0].metadata.intentClass, 'DETAILS_OR_PRICE');

const conversationExtraction = processExtractedCategory('conversation_script', {
  fullText: '', pages: [{ pageNumber: 1, lines: [
    'STAGE: acknowledgement',
    'INTENT_CLASS: ACKNOWLEDGEMENT',
    'EXAMPLES: tenant phrase one | tenant phrase two',
    'RESPONSE: Tenant-approved acknowledgement.',
  ] }],
});
assert.deepEqual(conversationExtraction.records[0].variables.find(
  (variable) => variable.key === 'intentClass',
), { key: 'intentClass', value: 'ACKNOWLEDGEMENT' });

console.log('Lightweight priority classifier and targeted retrieval plan verified.');
