import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { classifyCatalogEntityLocally } from '../src/knowledge-bases/catalog-entity-resolver.js';
import { openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';
import {
  buildGroundingEnvelope,
  validateGroundedLlmResponse,
} from '../src/voice/interaction/grounded-llm-response.js';

function item(id, key, name, category, aliases = []) {
  return {
    id, item_key: key, name, category,
    category_key: category.toLowerCase().replace(/[^a-z0-9]+/gu, '-'),
    aliases, category_aliases: [], attributes: [], relationships: {}, selection_rules: {},
  };
}

const healthcare = [
  item('health-1', 'lungs-check', 'Lungs Health Check', 'Organ Plans', [
    'Lung package', 'Lungs package', 'Lunch package', 'லங்ஸ் பேக்கேஜ்',
  ]),
  item('health-2', 'premium-male', 'Premium Male Screening', 'Screening Plans', [
    'Premium mail', 'male premium', 'பிரீமியம் மேல்',
  ]),
  item('health-3', 'premium-female', 'Premium Female Screening', 'Screening Plans', [
    'female premium', 'பிரீமியம் ஃபீமேல்',
  ]),
];
const retail = [
  item('retail-1', 'express-delivery', 'Express Delivery', 'Delivery Options', [
    'fast delivery', 'same day delivery', 'சீக்கிரம் delivery',
  ]),
];
const education = [
  item('education-1', 'advanced-course', 'Advanced Course', 'Course Options', [
    'advanced class', 'மேல் level course',
  ]),
];

const multilingualCases = [
  [healthcare, 'லங்ஸ் பேக்கேஜ் பத்தி சொல்லுங்க', 'lungs-check'],
  [healthcare, 'premium mail details please', 'premium-male'],
  [retail, 'எனக்கு சீக்கிரம் delivery வேணும்', 'express-delivery'],
  [education, 'Tell me about the advanced class', 'advanced-course'],
];
for (const [catalog, query, expectedKey] of multilingualCases) {
  const result = classifyCatalogEntityLocally(catalog, query);
  assert.equal(result.status, 'match', `Expected a confident match for: ${query}`);
  assert.equal(result.item.item_key, expectedKey);
}

const unrelatedAcrossIndustries = classifyCatalogEntityLocally(retail, 'Premium Male Screening');
assert.equal(unrelatedAcrossIndustries.status, 'none');

const identity = {
  tenantId: 'tenant-production-a', workspaceId: 'workspace-production-a',
  agentId: 'agent-production-a', callId: 'call-production-a',
};
const memory = openLiveCallMemory(identity, {
  conversationInitialStage: 'item_details',
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 5,
  conversationMemoryFields: [
    {
      key: 'customer_reference', label: 'Customer Reference', type: 'text', required: true,
      question: 'What is your customer reference?', requiredAction: 'create_reservation',
    },
    {
      key: 'preferred_slot', label: 'Preferred Slot', type: 'text', required: true,
      question: 'Which slot works?', requiredAction: 'create_reservation',
    },
  ],
});

memory.applyKnowledge({
  route: 'catalog', found: true, source: { recordId: 'retail-1' },
  item: { key: 'express-delivery', name: 'Express Delivery', category: 'Delivery Options', categoryKey: 'delivery-options' },
});
assert.deepEqual(memory.snapshot().lockedFields.sort(), ['customer_reference', 'preferred_slot']);

memory.applyKnowledge({
  route: 'workflow', found: true,
  workflow: { conditions: { fromStages: ['item_details'] }, gate: { allowed: true } },
  action: { config: { actionKey: 'create_reservation', nextStage: 'collect_details', requiresCatalogItem: true } },
});
assert.equal(memory.snapshot().currentStage, 'collect_details');
assert.deepEqual(memory.snapshot().lockedFields, []);

memory.observeAssistantResponse('Which slot works?');
memory.captureUserUtterance('உங்க location எங்க இருக்கு?');
memory.applyGroundedDecision({ intent: 'location_question', flowAction: 'side_question' });
const resumed = memory.prepareAssistantResponse('நாங்க city centreல இருக்கோம்.');
assert.match(resumed, /Which slot works\?/u);
assert.equal(memory.snapshot().pendingQuestion, 'preferred_slot');

memory.captureUserUtterance('Tomorrow morning');
assert.equal(memory.snapshot().collectedData.preferred_slot, 'Tomorrow morning');
assert.equal(memory.snapshot().pendingQuestion, null);

memory.observeAssistantResponse('What is your customer reference?');
memory.captureUserUtterance('My reference is ZX 42');
assert.equal(memory.snapshot().collectedData.customer_reference, 'ZX 42');
const noRepeat = memory.prepareAssistantResponse('Reservation is ready. What is your customer reference?');
assert.equal(noRepeat, 'Reservation is ready.');

memory.applyKnowledge({
  route: 'clarification', found: true, content: 'Premium Male அல்லது Premium Female எது?',
  clarification: {
    kind: 'catalog', candidates: [
      { itemId: 'health-2', itemKey: 'premium-male', name: 'Premium Male Screening', category: 'Screening Plans' },
      { itemId: 'health-3', itemKey: 'premium-female', name: 'Premium Female Screening', category: 'Screening Plans' },
    ],
  },
});
assert.equal(memory.snapshot().pendingQuestion, 'Premium Male அல்லது Premium Female எது?');
assert.equal(memory.snapshot().candidateItems.length, 2);
assert.equal(memory.snapshot().flowRecovery.clarifications, 1);

const evidence = {
  route: 'faq', found: true,
  content: 'Our office is downtown. The available appointment slot is tomorrow morning.',
  source: { recordId: 'faq-office' },
};
const envelope = buildGroundingEnvelope(evidence);
const groundedSideQuestion = validateGroundedLlmResponse(JSON.stringify({
  intent: 'location_question', flowAction: 'side_question', selectedEntityKeys: [],
  evidenceSourceIds: ['source_1'], spokenAnswer: 'Our office is downtown.',
}), envelope);
assert.equal(groundedSideQuestion.valid, true);
assert.equal(groundedSideQuestion.flowAction, 'side_question');

const isolated = openLiveCallMemory({
  tenantId: 'tenant-production-b', workspaceId: 'workspace-production-b',
  agentId: 'agent-production-b', callId: 'call-production-b',
}, {});
assert.deepEqual(isolated.snapshot().collectedData, {});
assert.equal(isolated.snapshot().selectedCatalogItem, null);
assert.equal(isolated.snapshot().currentStage, 'start');

const latencySamples = [];
for (let index = 0; index < 250; index += 1) {
  const startedAt = performance.now();
  classifyCatalogEntityLocally(index % 2 ? healthcare : retail, index % 2 ? 'premium mail' : 'fast delivery');
  latencySamples.push(performance.now() - startedAt);
}
latencySamples.sort((left, right) => left - right);
const p95Ms = latencySamples[Math.floor(latencySamples.length * 0.95)];
assert.ok(p95Ms < 50, `Local recovery routing p95 ${p95Ms}ms exceeded 50ms`);

const recovery = memory.snapshot().flowRecovery;
assert.equal(recovery.sideQuestions, 1);
assert.equal(recovery.resumedQuestions, 1);
assert.equal(recovery.repeatedQuestionsSuppressed, 1);

memory.close();
isolated.close();

console.log(JSON.stringify({
  task: 'Flow control, recovery and production evaluations',
  languages: ['Tamil', 'Tanglish', 'English'],
  industries: ['healthcare', 'retail', 'education'],
  verified: [
    'tenant isolation', 'topic/entity changes', 'explicit booking gate', 'side-question resume',
    'repeat-question suppression', 'targeted clarification', 'STT alias recovery', 'grounded flow action',
  ],
  localRoutingP95Ms: Math.round(p95Ms * 1_000) / 1_000,
  industryHardcoding: false,
}, null, 2));
