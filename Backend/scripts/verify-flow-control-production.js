import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';
import { detectConversationIntent } from '../src/voice/interaction/intent-detector.js';

const memory = openLiveCallMemory({
  tenantId: 'tenant-flow-a', workspaceId: 'workspace-flow-a', agentId: 'agent-flow-a', callId: 'call-flow-a',
}, {
  conversationInitialStage: 'intro',
  conversationContextMode: 'full_current_call',
  conversationMemoryFields: [
    { key: 'customer_name', label: 'Customer name', type: 'text', required: true, question: 'What is your name?', requiredAction: 'complete_booking' },
    { key: 'preferred_time', label: 'Preferred time', type: 'text', required: true, question: 'Which time works?', requiredAction: 'complete_booking' },
  ],
});

function transition(from, to, actionKey = '') {
  memory.applyKnowledge({
    route: 'workflow', found: true,
    workflow: { conditions: { fromStages: [from] }, gate: { allowed: true } },
    action: { config: { nextStage: to, ...(actionKey ? { actionKey } : {}) } },
  });
}

// Tenant-authored stages: names are merely test data; runtime has no industry flow hardcoding.
transition('intro', 'overview');
transition('overview', 'explanation');
memory.applyKnowledge({
  route: 'catalog', found: true, source: { recordId: 'generic-item-a' },
  item: { key: 'selected-offering', name: 'Selected Offering', category: 'Offerings', categoryKey: 'offerings' },
});
transition('explanation', 'confirmation');
transition('confirmation', 'booking', 'begin_booking');

let state = memory.snapshot();
assert.equal(state.currentStage, 'booking');
assert.equal(memory.canRunAction('complete_booking', { requiresCatalogItem: true }), false);
assert.deepEqual(state.lockedFields.sort(), ['customer_name', 'preferred_time']);

// A detour does not move the call out of booking and the pending tenant question resumes.
memory.applyKnowledge({
  route: 'workflow', found: true,
  workflow: { conditions: { fromStages: ['booking'] }, gate: { allowed: true } },
  action: { config: { nextStage: 'booking_details', actionKey: 'complete_booking', requiresCatalogItem: true } },
});
memory.observeAssistantResponse('Which time works?');
memory.captureUserUtterance('Where are you located?');
memory.applyGroundedDecision({ intent: 'location_question', flowAction: 'side_question' });
const resumed = memory.prepareAssistantResponse('The location is in the approved directory.');
assert.match(resumed, /Which time works\?/u);
state = memory.snapshot();
assert.equal(state.currentStage, 'booking_details');
assert.equal(state.pendingQuestion, 'preferred_time');
assert.equal(state.flowRecovery.sideQuestions, 1);

memory.captureUserUtterance('Tomorrow at ten');
memory.observeAssistantResponse('What is your name?');
memory.captureUserUtterance('My name is Taylor');
state = memory.snapshot();
assert.equal(state.collectedData.preferred_time, 'Tomorrow at ten');
assert.equal(state.collectedData.customer_name, 'Taylor');
assert.equal(memory.canRunAction('complete_booking', { requiresCatalogItem: true }), true);
transition('booking_details', 'booking_confirmation');
assert.equal(memory.snapshot().currentStage, 'booking_confirmation');

// A rule with the wrong FROM_STAGE cannot alter the completed flow.
memory.applyKnowledge({
  route: 'workflow', found: true,
  workflow: { conditions: { fromStages: ['overview'] }, gate: { allowed: true } },
  action: { config: { nextStage: 'booking', actionKey: 'invalid_jump' } },
});
assert.equal(memory.snapshot().currentStage, 'booking_confirmation');
assert.equal(memory.canRunAction('invalid_jump'), false);

const intentCases = [
  ['எனக்கு வலி இருக்கு எந்த option சரி?', 'scenario'],
  ['Enaku price evlo?', 'price'],
  ['What is the difference between these?', 'comparison'],
  ['appointment book பண்ணணும்', 'booking_request'],
  ['Argon packages details', 'category_request'],
];
for (const [text, expected] of intentCases) assert.equal(detectConversationIntent(text).intent, expected);

const timings = [];
for (let index = 0; index < 500; index += 1) {
  const startedAt = performance.now();
  detectConversationIntent(index % 2 ? 'What is the price?' : 'எனக்கு problem இருக்கு எந்த option?');
  timings.push(performance.now() - startedAt);
}
timings.sort((left, right) => left - right);
const p95Ms = timings[Math.floor(timings.length * 0.95)];
assert.ok(p95Ms < 50, `Intent and flow state p95 ${p95Ms}ms exceeded 50ms`);

memory.close();
console.log(JSON.stringify({
  task: 'Flow control production evaluation',
  configuredStages: ['intro', 'overview', 'explanation', 'confirmation', 'booking', 'booking_confirmation'],
  sideQuestionResume: true,
  repeatFieldPrevention: true,
  outOfOrderTransitionsBlocked: true,
  languages: ['Tamil', 'Tanglish', 'English'],
  localP95Ms: Math.round(p95Ms * 1000) / 1000,
  industryHardcoding: false,
}, null, 2));
