import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import {
  prepareKnowledgeQuery,
  refineKnowledgeResolution,
} from '../src/knowledge-engine/fast-query-preparation.js';
import { knowledgeQueryClasses } from '../src/knowledge-engine/query-classifier.js';

const tenantId = '91000000-0000-4000-8000-000000000001';
const agentId = '91000000-0000-4000-8000-000000000002';
const callId = '91000000-0000-4000-8000-000000000003';
const job = {
  tenant_id: tenantId,
  knowledge_base_id: '91000000-0000-4000-8000-000000000004',
  targetRevision: 1,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [agentId],
};

function record(index, type, value) {
  return {
    record_id: `92000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    record_type: type,
    document_id: `93000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    document_version_id: `94000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    usage_direction: 'both', language: 'mul', source_page_start: 1,
    entity_category_aliases: [], ...value,
  };
}

const first = record(1, 'catalog_item', {
  question: 'Nimbus plan', answer: 'Nimbus is published.', content: 'Nimbus is published.',
  entity_name: 'Nimbus plan', entity_category: 'Plans', entity_aliases: ['nimbus'],
  entity_metadata: { itemKey: 'nimbus', categoryKey: 'plans' },
});
const second = record(2, 'catalog_item', {
  question: 'Cirrus plan', answer: 'Cirrus is published.', content: 'Cirrus is published.',
  entity_name: 'Cirrus plan', entity_category: 'Plans', entity_aliases: ['cirrus'],
  entity_metadata: { itemKey: 'cirrus', categoryKey: 'plans' },
});
const safety = record(3, 'workflow_rule', {
  question: 'tenant urgent route', answer: 'Use tenant emergency guidance.', content: 'Emergency guidance.',
  entity_name: 'tenant urgent route', entity_category: 'safety', entity_aliases: ['tenant urgent phrase'],
  entity_metadata: {
    conditions: { examples: ['tenant urgent phrase'], intentClass: 'SAFETY_EMERGENCY' },
    actionType: 'respond', actionConfig: { responseMode: 'exact' }, priority: 100,
  },
});
const callControl = record(4, 'workflow_rule', {
  question: 'tenant end route', answer: 'Use tenant closing guidance.', content: 'Closing guidance.',
  entity_name: 'tenant end route', entity_category: 'control', entity_aliases: ['tenant end phrase'],
  entity_metadata: {
    conditions: { examples: ['tenant end phrase'], intentClass: 'CALL_CONTROL' },
    actionType: 'respond', actionConfig: { responseMode: 'exact' }, priority: 90,
  },
});
const purpose = record(5, 'conversation_node', {
  question: 'Tenant purpose route', answer: 'Tenant purpose response.', content: 'Tenant purpose response.',
  entity_name: 'Tenant purpose route', entity_category: 'main',
  entity_aliases: ['tenant purpose phrase'],
  entity_metadata: { intentClass: 'KNOWN_INFORMATION' },
});
const action = record(6, 'workflow_rule', {
  question: 'tenant configured action', answer: 'Use assigned tenant tool.', content: 'Action guidance.',
  entity_name: 'tenant configured action', entity_category: 'action',
  entity_aliases: ['tenant action phrase'],
  entity_metadata: {
    conditions: { examples: ['tenant action phrase'], intentClass: 'ACTION_TOOL_REQUEST' },
    actionType: 'configured_tool',
    actionConfig: { actionKey: 'tenant_action', toolIdentifier: 'tenant_action' }, priority: 80,
  },
});
const contextualFact = record(7, 'workflow_rule', {
  question: 'tenant metric route', answer: 'Use the active item metric.', content: 'Metric guidance.',
  entity_name: 'tenant metric route', entity_category: 'information',
  entity_aliases: ['tenant metric phrase'],
  entity_metadata: {
    conditions: { examples: ['tenant metric phrase'], intentClass: 'DETAILS_OR_PRICE' },
    actionType: 'respond',
    actionConfig: { responseMode: 'grounded', requiresCatalogItem: true }, priority: 70,
  },
});
const bundle = buildPublicationIndexes(
  job, [first, second, safety, callControl, purpose, action, contextualFact],
);

const memory = {
  activeEntity: { recordId: first.record_id, itemKey: 'nimbus', name: 'Nimbus plan' },
  recentConversation: [
    { role: 'user', content: 'Tell me about Nimbus.' },
    { role: 'assistant', content: 'Nimbus information.' },
  ],
};

let prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'arbitrary contextual follow-up', memory,
  requestedFacts: ['price'], contextualReferences: ['active published entity'],
}), bundle);
assert.equal(prepared.requestedFact, 'price');
assert.equal(prepared.usesCallMemory, true);
assert.equal(prepared.understanding.contextDependent, true);
assert.equal(prepared.understanding.canonicalContext.recordId, first.record_id);
assert.equal(prepared.understanding.requestedFact, 'price');
assert.ok(prepared.contextualReferences.includes('active_entity'));
assert.equal(prepared.classification.selectedNamespace, 'CATALOG');
prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'unstructured contextual continuation', memory,
}), bundle);
assert.equal(prepared.understanding.contextDependent, true);
assert.equal(prepared.understanding.requestedFact, null);
assert.equal(prepared.understanding.requiresGroundedFactInterpretation, true);
assert.equal(prepared.classification.intentClass, knowledgeQueryClasses.DETAILS_OR_PRICE);
assert.equal(prepared.classification.source, 'contextual_call_memory');
assert.equal(prepared.classification.selectedNamespace, 'CATALOG');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant metric phrase', memory,
}), bundle);
assert.equal(prepared.understanding.contextDependent, true,
  'A published fact workflow must retain the active canonical entity');
assert.equal(prepared.understanding.canonicalContext.recordId, first.record_id);
assert.equal(prepared.usesCallMemory, true);
assert.equal(prepared.understanding.currentRouteSignal.actionType, 'respond');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'unstructured contextual continuation', memory,
}), bundle);
assert.equal(prepared.classification.intentClass, knowledgeQueryClasses.DETAILS_OR_PRICE);
assert.equal(prepared.resolution.candidate, null,
  'Call memory must not be misrepresented as an explicit current-turn entity match');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'Cirrus', memory,
}), bundle);
assert.equal(prepared.understanding.contextDependent, false);
assert.equal(prepared.understanding.explicitEntities[0].recordId, second.record_id);
assert.equal(prepared.understanding.canonicalContext.recordId, second.record_id);
assert.equal(prepared.resolution.candidate.itemKey, 'cirrus');
assert.equal(prepared.resolution.explicitEntity, true);
assert.equal(prepared.usesCallMemory, false);

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'Nimbus Cirrus', memory,
}), bundle);
assert.deepEqual(new Set(prepared.understanding.comparisonEntities.map((entity) => entity.recordId)),
  new Set([first.record_id, second.record_id]));

assert.equal(prepared.intentClass, knowledgeQueryClasses.COMPARISON_COMPLEX);
assert.equal(prepared.classification.selectedNamespace, 'CATALOG');
assert.deepEqual(new Set(prepared.resolution.routingCandidates.map((candidate) => candidate.itemKey)),
  new Set(['nimbus', 'cirrus']));

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant purpose phrase Nimbus', memory,
}), bundle);
assert.equal(prepared.resolution.candidate.itemKey, 'nimbus',
  'An explicit Catalog entity must override generic Conversation guidance and stale memory');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant urgent phrase', memory,
}), bundle);
assert.equal(prepared.intentClass, knowledgeQueryClasses.SAFETY_EMERGENCY);
assert.equal(prepared.priorityIntent, true);
assert.equal(prepared.deterministicProtocolException, knowledgeQueryClasses.SAFETY_EMERGENCY);
assert.equal(prepared.retrievalHints.role, 'RETRIEVAL_HINTS');
assert.equal(prepared.retrievalHints.decisionAuthority, false);
assert.equal(prepared.retrievalHints.clarificationAuthority, false);
assert.equal(prepared.retrievalHints.toolExecutionAuthority, false);

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant end phrase', memory,
}), bundle);
assert.equal(prepared.intentClass, knowledgeQueryClasses.CALL_CONTROL);
assert.equal(prepared.priorityIntent, false);
assert.equal(prepared.deterministicProtocolException, null);

let classifyCalls = 0;
prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant action phrase', memory,
}), bundle);
assert.equal(prepared.intentClass, knowledgeQueryClasses.ACTION_TOOL_REQUEST);
assert.equal(prepared.retrievalHints.toolExecutionAuthority, false);
assert.equal(prepared.understanding.actionIntent.detected, true);
assert.equal(prepared.understanding.actionIntent.source, 'published_workflow');

await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'Nimbus', memory,
}), bundle, {}, {
  classify: async (input, resolution) => {
    classifyCalls += 1;
    return {
      tenantId: input.tenantId, agentId: input.agentId, callId: input.callId,
      intentClass: knowledgeQueryClasses.KNOWN_INFORMATION,
      candidate: resolution.candidate, requiresConfirmation: false,
      retrievalPlan: { indexes: ['ANSWER_CARD'], useSemantic: false },
    };
  },
});
assert.equal(classifyCalls, 1, 'Fast query preparation must classify exactly once');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'a natural paraphrase without published words', memory: {},
}), bundle);
let refined = await refineKnowledgeResolution(
  prepared.input, bundle, prepared.resolution,
  prepared.classification,
  [{ recordId: second.record_id, recordType: 'CATALOG_ITEM', score: 0.82 }],
);
assert.equal(refined.candidate.itemKey, 'cirrus',
  'Semantic meaning must recover an entity when tenant lexical forms do not match');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'Nimbus', memory,
}), bundle);
refined = await refineKnowledgeResolution(
  prepared.input, bundle, prepared.resolution,
  prepared.classification,
  [{ recordId: second.record_id, recordType: 'CATALOG_ITEM', score: 0.99 }],
);
assert.equal(refined.candidate.itemKey, 'nimbus',
  'Semantic similarity must never replace the latest explicit published entity');

prepared = await prepareKnowledgeQuery(createKnowledgeEngineInput({
  tenantId, agentId, callId, utterance: 'tenant purpose phrase', memory,
}), bundle);
refined = await refineKnowledgeResolution(
  prepared.input, bundle, prepared.resolution, prepared.classification,
  [{ recordId: second.record_id, recordType: 'CATALOG_ITEM', score: 0.99 }],
);
assert.equal(refined.candidate.recordId, purpose.record_id,
  'Semantic Catalog matches must never replace an explicit Conversation route');

console.log('Tenant-driven query preparation, memory and namespace priority routing verified.');
