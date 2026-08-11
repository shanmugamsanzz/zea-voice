import assert from 'node:assert/strict';
import { compactLiveCallMemoryContext, openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';

const identity = {
  tenantId: 'tenant-frame-a', workspaceId: 'workspace-frame-a',
  agentId: 'agent-frame-a', callId: 'call-frame-a',
};
const memory = openLiveCallMemory(identity, {
  conversationInitialStage: 'catalog_overview',
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 5,
  conversationMemoryFields: [
    { key: 'customer_reference', label: 'Reference', type: 'text', required: true, question: 'What is your reference?' },
    {
      key: 'preferred_slot', label: 'Preferred Slot', type: 'text', required: true,
      question: 'Which slot works?', requiredAction: 'reserve_item',
    },
  ],
});

memory.applyKnowledge({
  route: 'catalog',
  source: { recordId: 'category-source' },
  category: {
    key: 'service-plans', name: 'Service Plans', parentKey: 'all-services',
    description: 'Available service levels',
    items: [
      { key: 'standard-plan', name: 'Standard Plan', categoryKey: 'service-plans' },
      { key: 'premium-plan', name: 'Premium Plan', categoryKey: 'service-plans' },
    ],
  },
});
let frame = memory.snapshot();
assert.equal(frame.currentStage, 'catalog_overview');
assert.equal(frame.activeCategory.key, 'service-plans');
assert.equal(frame.activeCategory.parentKey, 'all-services');
assert.deepEqual(frame.candidateItems.map((item) => item.key), ['standard-plan', 'premium-plan']);
assert.equal(frame.selectedItem, null);

memory.applyKnowledge({
  route: 'clarification', found: true,
  content: 'Standard Plan or Premium Plan?',
  clarification: {
    kind: 'catalog', confidence: 0.72,
    candidates: [
      { itemId: 'item-standard', itemKey: 'standard-plan', name: 'Standard Plan', category: 'Service Plans' },
      { itemId: 'item-premium', itemKey: 'premium-plan', name: 'Premium Plan', category: 'Service Plans' },
    ],
  },
});
frame = memory.snapshot();
assert.equal(frame.resumeStage, 'catalog_overview');
assert.equal(frame.pendingQuestion, 'Standard Plan or Premium Plan?');
assert.equal(frame.candidateItems.length, 2);
memory.captureUserUtterance('Premium one');
assert.equal(memory.snapshot().pendingQuestion, 'Standard Plan or Premium Plan?');

memory.applyKnowledge({
  route: 'catalog',
  source: { recordId: 'item-premium' },
  item: {
    key: 'premium-plan', name: 'Premium Plan', category: 'Service Plans',
    categoryKey: 'service-plans', parentCategoryKey: 'all-services',
  },
});
frame = memory.snapshot();
assert.equal(frame.selectedItem.id, 'item-premium');
assert.equal(frame.selectedCatalogItem.key, 'premium-plan');
assert.equal(frame.activeCategory.key, 'service-plans');
assert.equal(frame.candidateItems.length, 0);
assert.equal(frame.resumeStage, null);
assert.equal(frame.pendingQuestion, null);
assert.ok(frame.answeredQuestions.includes('Standard Plan or Premium Plan?'));

memory.observeAssistantResponse('What is your reference?');
assert.equal(memory.snapshot().pendingQuestion, 'customer_reference');
memory.captureUserUtterance('My reference is Alpha 42');
frame = memory.snapshot();
assert.equal(frame.collectedData.customer_reference, 'Alpha 42');
assert.ok(frame.answeredQuestions.includes('What is your reference?'));
assert.ok(frame.lockedFields.includes('preferred_slot'));

memory.applyKnowledge({
  route: 'workflow',
  workflow: { conditions: { fromStages: ['catalog_overview'] }, gate: { allowed: true } },
  action: { config: { actionKey: 'reserve_item', nextStage: 'collect_details', requiresCatalogItem: true } },
});
frame = memory.snapshot();
assert.equal(frame.currentStage, 'collect_details');
assert.ok(!frame.lockedFields.includes('preferred_slot'));

memory.observeAssistantResponse('Which slot works?');
assert.equal(memory.snapshot().pendingQuestion, 'preferred_slot');
memory.captureUserUtterance('Where is your office?');
memory.applyKnowledge({
  route: 'faq', found: true, content: 'Our office is downtown.',
  source: { recordId: 'faq-location' },
});
frame = memory.snapshot();
assert.equal(frame.pendingQuestion, 'preferred_slot');
assert.equal(frame.resumeQuestionAfterAnswer, 'Which slot works?');
const resumedAnswer = memory.prepareAssistantResponse('Our office is downtown. What is your reference?');
assert.equal(resumedAnswer, 'Our office is downtown. Which slot works?');
frame = memory.snapshot();
assert.equal(frame.flowRecovery.sideQuestions, 1);
assert.equal(frame.flowRecovery.resumedQuestions, 1);
assert.equal(frame.flowRecovery.repeatedQuestionsSuppressed, 1);
memory.captureUserUtterance('Tomorrow at ten');
assert.equal(memory.snapshot().collectedData.preferred_slot, 'Tomorrow at ten');
assert.equal(memory.snapshot().pendingQuestion, null);

memory.suspendForDetour();
assert.equal(memory.snapshot().resumeStage, 'collect_details');
memory.resumeFromDetour();
assert.equal(memory.snapshot().currentStage, 'collect_details');
assert.equal(memory.snapshot().resumeStage, null);

const compact = compactLiveCallMemoryContext({
  snapshot: memory.snapshot(),
  collectedData: memory.snapshot().collectedData,
  missingFields: memory.snapshot().missingFields,
}, 1_000);
assert.equal(compact.currentStage, 'collect_details');
assert.equal(compact.activeCategory.key, 'service-plans');
assert.equal(compact.selectedCatalogItem.key, 'premium-plan');
assert.ok(compact.answeredQuestions.length >= 1);
assert.ok(JSON.stringify(compact).length <= 1_000);

const isolated = openLiveCallMemory({ ...identity, tenantId: 'tenant-frame-b', callId: 'call-frame-b' }, {});
assert.equal(isolated.snapshot().activeCategory, null);
assert.equal(isolated.snapshot().selectedItem, null);
assert.deepEqual(isolated.snapshot().collectedData, {});

memory.close();
isolated.close();
console.log(JSON.stringify({
  task: 'Live conversation frame',
  tracked: [
    'currentStage', 'activeCategory', 'selectedItem', 'candidateItems', 'pendingQuestion',
    'resumeStage', 'answeredQuestions', 'collectedConfigurableFields',
  ],
  tenantIsolation: true,
  industryHardcoding: false,
}, null, 2));
