import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import {
  knowledgeResolutionActions,
  knowledgeResolutionConfidence,
  resolvePublishedEntityRoute,
} from '../src/knowledge-engine/entity-route-resolver.js';

const tenantId = '20000000-0000-4000-8000-000000000001';
const agentId = '20000000-0000-4000-8000-000000000002';
const callId = '20000000-0000-4000-8000-000000000003';
const job = {
  tenant_id: tenantId,
  knowledge_base_id: '20000000-0000-4000-8000-000000000004',
  targetRevision: 1,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [agentId],
};

function record(index, overrides) {
  return {
    record_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    record_type: 'catalog_item',
    document_id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    document_version_id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    usage_direction: 'both',
    language: 'mul',
    source_page_start: 1,
    entity_category: 'Published options',
    entity_category_aliases: [],
    ...overrides,
  };
}

const alpha = record(1, {
  question: 'Alpha Prime',
  answer: 'Alpha Prime is the published first option.',
  content: 'Alpha Prime is the published first option.',
  entity_name: 'Alpha Prime',
  entity_aliases: ['Starter choice', 'ஆல்பா பிரைம்', 'aalpaa prime'],
  entity_metadata: { itemKey: 'alpha-prime', categoryKey: 'published-options' },
});
const beta = record(2, {
  question: 'Beta Voice',
  answer: 'Beta Voice is the published second option.',
  content: 'Beta Voice is the published second option.',
  entity_name: 'Beta Voice',
  entity_aliases: ['Second choice'],
  entity_metadata: { itemKey: 'beta-voice', categoryKey: 'published-options' },
});
const ambiguousOne = record(3, {
  question: 'Shared route one', answer: 'First shared response.', content: 'First shared response.',
  entity_name: 'Shared route one', entity_aliases: ['shared'],
  entity_metadata: { itemKey: 'shared-one', categoryKey: 'published-options' },
});
const ambiguousTwo = record(4, {
  question: 'Shared route two', answer: 'Second shared response.', content: 'Second shared response.',
  entity_name: 'Shared route two', entity_aliases: ['shared'],
  entity_metadata: { itemKey: 'shared-two', categoryKey: 'published-options' },
});
const genericConversation = {
  ...record(5, {}),
  record_type: 'conversation_node',
  question: 'Generic overview', answer: 'Generic overview response.', content: 'Generic overview response.',
  entity_name: 'Generic overview', entity_aliases: ['Alpha Prime'], entity_category_aliases: [],
  entity_metadata: { intentClass: 'KNOWN_INFORMATION' },
};
const bundle = buildPublicationIndexes(job, [alpha, beta, ambiguousOne, ambiguousTwo, genericConversation]);

function input(utterance, memory = {}) {
  return createKnowledgeEngineInput({ tenantId, agentId, callId, utterance, memory });
}

let result = resolvePublishedEntityRoute(input('Alpha Prime'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.action, knowledgeResolutionActions.CONTINUE);
assert.equal(result.candidate.itemKey, 'alpha-prime');
assert.equal(result.candidate.method, 'exact');
assert.equal(result.candidate.recordType, 'CATALOG_ITEM',
  'A specific Catalog entity must override a colliding generic Conversation route');

result = resolvePublishedEntityRoute(input('Please explain the starter choice'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.itemKey, 'alpha-prime');
assert.equal(result.candidate.method, 'tenant_alias');

result = resolvePublishedEntityRoute(input('ஆல்பா பிரைம் பற்றி சொல்லுங்கள்'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.itemKey, 'alpha-prime');

result = resolvePublishedEntityRoute(input('aalpaa prime details'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.itemKey, 'alpha-prime');

result = resolvePublishedEntityRoute(input('Published options'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.entityType, 'CATEGORY');
assert.equal(result.candidate.categoryKey, 'published-options');
assert.equal(result.candidate.evidenceRecordIds.length, 4);
assert.equal(result.candidate.children.length, 4);

result = resolvePublishedEntityRoute(input('Beta Voise'), bundle);
assert.ok([knowledgeResolutionConfidence.HIGH, knowledgeResolutionConfidence.MEDIUM].includes(result.confidence));
assert.equal(result.candidate.itemKey, 'beta-voice');
assert.ok(['phonetic', 'fuzzy'].includes(result.candidate.method));

result = resolvePublishedEntityRoute(input('shared'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.MEDIUM);
assert.equal(result.action, knowledgeResolutionActions.CONFIRM);
assert.equal(result.alternatives.length > 0, true);

result = resolvePublishedEntityRoute(input('tell me more', {
  activeEntity: { recordId: alpha.record_id, key: 'alpha-prime' },
}), bundle);
assert.equal(result.candidate.itemKey, 'alpha-prime');
assert.equal(result.candidate.method, 'context');
assert.equal(result.action, knowledgeResolutionActions.RETRIEVE);

result = resolvePublishedEntityRoute(input('Beta Voice', {
  activeEntity: { recordId: alpha.record_id, key: 'alpha-prime' },
}), bundle);
assert.equal(result.candidate.itemKey, 'beta-voice', 'Explicit new entity must override stale call context');
assert.equal(result.explicitEntity, true);

result = resolvePublishedEntityRoute(input('unmapped complex request'), bundle, {
  semanticMatches: [{ recordId: beta.record_id, score: 0.76 }],
});
assert.equal(result.confidence, knowledgeResolutionConfidence.MEDIUM);
assert.equal(result.action, knowledgeResolutionActions.CONFIRM);
assert.equal(result.candidate.itemKey, 'beta-voice');
assert.equal(result.candidate.method, 'semantic');

result = resolvePublishedEntityRoute(input('completely unknown utterance'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.LOW);
assert.equal(result.action, knowledgeResolutionActions.CLARIFY);
assert.equal(result.candidate, null);

assert.throws(() => resolvePublishedEntityRoute({
  ...input('Alpha Prime'), tenantId: 'another-tenant',
}, bundle), /same tenant/u);

console.log('Fast universal entity and route resolution verified.');
