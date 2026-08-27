import assert from 'node:assert/strict';
import { createKnowledgeEngineInput } from '../src/knowledge-engine/engine-contract.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import {
  knowledgeCandidateNamespaces,
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
const gold = record(6, {
  question: 'Gold Master Health Checkup', answer: 'Gold package approved details.',
  content: 'Gold package approved details.', entity_name: 'Gold Master Health Checkup',
  entity_aliases: ['gold', 'gold package', 'gold checkup'],
  entity_category: 'Master Health Check-up',
  entity_category_aliases: ['master packages'],
  entity_metadata: { itemKey: 'gold-master-health-checkup', categoryKey: 'master-health-checkup' },
});
const oncoMale = record(7, {
  question: 'Onco Care Male', answer: 'Approved male oncology details.',
  content: 'Approved male oncology details.', entity_name: 'Onco Care Male',
  entity_aliases: ['male oncology screening'], entity_category: 'Oncology Screening',
  entity_category_aliases: ['onco care', 'onco package', 'oncology package'],
  entity_metadata: { itemKey: 'onco-care-male', categoryKey: 'oncology-screening' },
});
const oncoFemale = record(8, {
  question: 'Onco Care Female', answer: 'Approved female oncology details.',
  content: 'Approved female oncology details.', entity_name: 'Onco Care Female',
  entity_aliases: ['female oncology screening'], entity_category: 'Oncology Screening',
  entity_category_aliases: ['onco care', 'onco package', 'oncology package'],
  entity_metadata: { itemKey: 'onco-care-female', categoryKey: 'oncology-screening' },
});
const renal = record(9, {
  question: 'Renal Health Checkup', answer: 'Approved renal details.', content: 'Approved renal details.',
  entity_name: 'Renal Health Checkup', entity_aliases: ['renal package'],
  entity_category: 'Organ-Specific Health Check-ups',
  entity_category_aliases: ['organ specific packages', 'organ health packages'],
  entity_metadata: { itemKey: 'renal-health-checkup', categoryKey: 'organ-specific-health-checkups' },
});
const lungs = record(10, {
  question: 'Lungs Health Checkup', answer: 'Approved lungs details.', content: 'Approved lungs details.',
  entity_name: 'Lungs Health Checkup', entity_aliases: ['lungs package'],
  entity_category: 'Organ-Specific Health Check-ups',
  entity_category_aliases: ['organ specific packages', 'organ health packages'],
  entity_metadata: { itemKey: 'lungs-health-checkup', categoryKey: 'organ-specific-health-checkups' },
});
const generalScreening = record(11, {
  question: 'General Screening', answer: 'Approved general screening details.',
  content: 'Approved general screening details.', entity_name: 'General Screening',
  entity_aliases: ['health checkup'], entity_category: 'General Services',
  entity_category_aliases: ['general services'],
  entity_metadata: { itemKey: 'general-screening', categoryKey: 'general-services' },
});
const youthScreening = record(12, {
  question: 'Youth Screening', answer: 'Approved youth screening details.',
  content: 'Approved youth screening details.', entity_name: 'Youth Screening',
  entity_aliases: ['youth health screening'], entity_category: 'Youth Services',
  entity_category_aliases: ['youth services'],
  entity_metadata: { itemKey: 'youth-screening', categoryKey: 'youth-services' },
});
const unrelatedControl = {
  ...record(13, {}),
  record_type: 'workflow_rule',
  question: 'tenant stop route', answer: 'Approved stop response.', content: 'Approved stop response.',
  entity_name: 'tenant_stop_route', entity_aliases: ['youth health checkout'],
  entity_category_aliases: [],
  entity_metadata: {
    conditions: { examples: ['youth health checkout'], intentClass: 'CALL_CONTROL' },
    actionType: 'respond', actionConfig: { responseMode: 'exact' },
  },
};
const bundle = buildPublicationIndexes(job, [
  alpha, beta, ambiguousOne, ambiguousTwo, genericConversation,
  gold, oncoMale, oncoFemale, renal, lungs, generalScreening, youthScreening,
]);

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
assert.equal(result.routingCandidates.length, 1,
  'A strong canonical entity must discard weaker discovery candidates');

result = resolvePublishedEntityRoute(input('Please explain the starter choice'), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.itemKey, 'alpha-prime');
assert.ok(['tenant_alias', 'stt'].includes(result.candidate.method));

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
assert.equal(result.routingCandidates.length, 2,
  'Two records sharing an exact published alias must remain genuinely ambiguous');

result = resolvePublishedEntityRoute(input('tell me more', {
  activeEntity: { recordId: alpha.record_id, key: 'alpha-prime' },
}), bundle);
assert.equal(result.candidate, null,
  'Memory must not be converted into a current-turn entity match before grounded understanding');

result = resolvePublishedEntityRoute(input('What details are included in this?', {
  activeEntity: { recordId: alpha.record_id, key: 'alpha-prime' },
}), bundle);
assert.equal(result.candidate, null);

result = resolvePublishedEntityRoute(input('\u0b85\u0ba4\u0bc1\u0bb2 \u0b8e\u0ba9\u0bcd\u0ba9 details \u0b87\u0bb0\u0bc1\u0b95\u0bcd\u0b95\u0bc1?', {
  activeCategory: {
    id: oncoMale.record_id, key: 'oncology-screening', name: 'Oncology Screening',
  },
}), bundle);
assert.equal(result.candidate, null,
  'Language-specific contextual phrases must not be required by the resolver');

result = resolvePublishedEntityRoute(input('Beta Voice', {
  activeEntity: { recordId: alpha.record_id, key: 'alpha-prime' },
}), bundle);
assert.equal(result.candidate.itemKey, 'beta-voice', 'Explicit new entity must override stale call context');
assert.equal(result.explicitEntity, true);

const staleAlphaMemory = {
  activeEntity: { recordId: alpha.record_id, key: 'alpha-prime' },
  pendingClarification: { kind: 'ambiguity', text: 'Which option?' },
};

result = resolvePublishedEntityRoute(input('Oncocare package பற்றி சொல்லுங்க', staleAlphaMemory), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.entityType, 'CATEGORY');
assert.equal(result.candidate.categoryKey, 'oncology-screening');
assert.equal(result.explicitEntity, true);

result = resolvePublishedEntityRoute(input('on cooker package pathi sollunga', staleAlphaMemory), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.MEDIUM);
assert.equal(result.action, knowledgeResolutionActions.CONFIRM);
assert.equal(result.candidate.entityType, 'CATEGORY');
assert.equal(result.candidate.categoryKey, 'oncology-screening');
assert.ok(['phonetic', 'fuzzy'].includes(result.candidate.method));

const unrelatedOnlyBundle = buildPublicationIndexes(job, [alpha, beta]);
result = resolvePublishedEntityRoute(
  input('on cooker package pathi sollunga', staleAlphaMemory), unrelatedOnlyBundle,
);
assert.equal(result.candidate, null,
  'A phonetic utterance must not resolve when the tenant has no supporting published entity');

result = resolvePublishedEntityRoute(input('Gold package பத்தி சொல்லுங்க', {
  activeCategory: { recordId: oncoMale.record_id, key: 'oncology-screening' },
}), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.entityType, 'ITEM');
assert.equal(result.candidate.itemKey, 'gold-master-health-checkup');

result = resolvePublishedEntityRoute(input('Organ specific package பற்றி சொல்லுங்க', {
  activeEntity: { recordId: gold.record_id, key: 'gold-master-health-checkup' },
}), bundle);
assert.equal(result.confidence, knowledgeResolutionConfidence.HIGH);
assert.equal(result.candidate.entityType, 'CATEGORY');
assert.equal(result.candidate.categoryKey, 'organ-specific-health-checkups');
assert.equal(result.candidate.evidenceRecordIds.length, 2);

const namespaceInput = input('youth health checkup', {
  activeEntity: { recordId: generalScreening.record_id, key: 'general-screening' },
  pendingClarification: { kind: 'ambiguity', text: 'Which published option?' },
});
const collisionBundle = buildPublicationIndexes(job, [
  generalScreening, youthScreening, unrelatedControl,
]);
result = resolvePublishedEntityRoute(namespaceInput, collisionBundle);
assert.equal(result.candidateNamespace, knowledgeCandidateNamespaces.CATALOG);
assert.equal(result.candidate.itemKey, 'youth-screening',
  'Distinctive tenant terms must outrank a generic contained alias and stale memory');
assert.equal(result.routingCandidates.every((candidate) => (
  ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(candidate.recordType)
)), true, 'Catalog ambiguity candidates must never contain Workflow or call-control records');
assert.equal(result.routingCandidates.some((candidate) => candidate.label === 'tenant_stop_route'), false);

result = resolvePublishedEntityRoute(input('a completely different unresolved topic now', {
  activeEntity: { recordId: gold.record_id, key: 'gold-master-health-checkup' },
}), bundle);
assert.equal(result.candidate, null, 'A long unresolved request must not silently reuse stale item memory');

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

const exactPublishedRoute = {
  ...record(14, {}),
  record_type: 'faq',
  question: 'Where is the support desk?',
  answer: 'The approved support desk location is published.',
  content: 'The approved support desk location is published.',
  entity_name: 'Support desk location',
  entity_aliases: ['support desk location'],
  entity_category_aliases: [],
  entity_metadata: { intentClass: 'KNOWN_INFORMATION' },
};
const fuzzyCatalogCollision = record(15, {
  question: 'Support Desk Location Plus',
  answer: 'A different published option.',
  content: 'A different published option.',
  entity_name: 'Support Desk Location Plus',
  entity_aliases: [],
  entity_metadata: { itemKey: 'support-desk-location-plus', categoryKey: 'published-options' },
});
result = resolvePublishedEntityRoute(input('support desk location'),
  buildPublicationIndexes(job, [exactPublishedRoute, fuzzyCatalogCollision]));
assert.equal(result.candidateNamespace, knowledgeCandidateNamespaces.FAQ,
  'An exact current published route must outrank a merely fuzzy Catalog collision');

assert.throws(() => resolvePublishedEntityRoute({
  ...input('Alpha Prime'), tenantId: 'another-tenant',
}, bundle), /same tenant/u);

console.log('Fast universal entity and route resolution verified.');
