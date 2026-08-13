import assert from 'node:assert/strict';
import {
  normalizeLiveMemorySettings,
  resolveLiveMemoryConfiguration,
} from '../src/voice/interaction/live-memory-config.js';
import {
  activeLiveCallMemoryCount,
  compactLiveCallMemoryContext,
  openLiveCallMemory,
} from '../src/voice/interaction/live-call-memory.js';
import { LiveMemoryMaintenanceQueue } from '../src/voice/interaction/live-memory-maintenance.js';
import { buildConversationMemoryState } from '../src/voice/interaction/conversation-memory-state.js';

const settings = normalizeLiveMemorySettings({
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 2,
  conversationMemoryFields: [
    { key: 'lead_name', label: 'Lead Name', type: 'text', required: true, question: 'Your name?' },
    { key: 'preferred_date', label: 'Preferred Date', type: 'date', required: false, question: 'Which date?' },
  ],
});
assert.equal(settings.conversationContextTurns, 2);
assert.equal(settings.conversationMemoryFields.length, 2);
assert.equal(resolveLiveMemoryConfiguration({}).mode, 'last_n_turns');

const identity = { tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a' };
const session = openLiveCallMemory(identity, settings, 1);
session.setLanguage('ta-IN');
assert.equal(session.snapshot().language, 'ta');
session.append({ role: 'assistant', content: 'Welcome', at: 2 });
session.append({ role: 'user', content: 'First request', at: 3 });
session.append({ role: 'assistant', content: 'First response', at: 4 });
session.append({ role: 'user', content: 'Second request', at: 5 });
session.append({ role: 'assistant', content: 'Second response', at: 6 });
session.append({ role: 'user', content: 'Third request', at: 7 });
const snapshot = session.mergeCollectedData({ lead_name: 'Shanmugam', unknown_field: 'ignored' });
assert.equal(snapshot.messages.filter((entry) => entry.role === 'user').length, 2);
assert.deepEqual(snapshot.collectedData, { lead_name: 'Shanmugam' });
session.observeAssistantResponse('Which date?');
assert.equal(session.snapshot().pendingQuestion, 'preferred_date');
const captured = session.captureUserUtterance('tomorrow');
assert.deepEqual(captured.updates, { preferred_date: 'tomorrow' });

assert.equal(captured.state.pendingQuestion, null);
assert.deepEqual(captured.state.missingFields, []);
assert.equal(activeLiveCallMemoryCount(), 1);

const isolated = openLiveCallMemory({ ...identity, tenantId: 'tenant-b', callId: 'call-b' }, {
  conversationContextMode: 'full_current_call', conversationMemoryFields: [],
});
const namedDateSession = openLiveCallMemory({ ...identity, callId: 'call-date' }, settings, 1);
namedDateSession.observeAssistantResponse('Which date?');
const namedMonthDate = namedDateSession.captureUserUtterance('13th August');
assert.deepEqual(namedMonthDate.updates, { preferred_date: '13th August' });
isolated.append({ role: 'user', content: 'Company B', at: 8 });
assert.equal(isolated.snapshot().messages.length, 1);
assert.equal(session.snapshot().messages.some((entry) => entry.content === 'Company B'), false);
assert.equal(activeLiveCallMemoryCount(), 3);

const combined = openLiveCallMemory({ ...identity, callId: 'call-combined' }, {
  conversationContextMode: 'last_n_turns',
  conversationContextTurns: 5,
  conversationMemoryFields: [
    { key: 'customer_name', label: 'Customer Name', type: 'text', required: true, question: 'Your name?' },
    { key: 'customer_age', label: 'Customer Age', type: 'number', required: true, question: 'Your age?' },
  ],
});
const combinedCapture = combined.captureUserUtterance('My name is Shanmugam, age is 21');
assert.deepEqual(combinedCapture.updates, { customer_name: 'Shanmugam', customer_age: '21' });
assert.deepEqual(combinedCapture.state.missingFields, []);
assert.equal(activeLiveCallMemoryCount(), 4);

const oversizedContext = compactLiveCallMemoryContext({
  snapshot: {
    mode: 'full_current_call', runningSummary: 'summary '.repeat(1_000),
    completedQuestions: Array.from({ length: 30 }, (_, index) => `field_${index}`),
    currentTopic: 'appointment', pendingQuestion: 'field_29',
  },
  collectedData: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, `value ${index} `.repeat(20)])),
  missingFields: [{ key: 'field_29', label: 'Final field', type: 'text', question: 'Please provide the final field?' }],
});
assert.ok(JSON.stringify(oversizedContext).length <= 1_000);
assert.equal(oversizedContext.nextMissingField.key, 'field_29');

const framedLanguage = compactLiveCallMemoryContext({
  snapshot: { language: 'ta', currentStage: 'selection', activeCategory: { key: 'services', name: 'Services' } },
  collectedData: {}, missingFields: [],
});
assert.equal(framedLanguage.language, 'ta');

const restorableIdentity = { ...identity, callId: 'call-restorable' };
const restorable = openLiveCallMemory(restorableIdentity, settings, 10, {
  callId: restorableIdentity.callId,
  currentStage: 'item_explanation',
  resumeStage: 'item_selection',
  currentTopic: 'Standard Plan',
  activeCategory: { key: 'service-plans', name: 'Service Plans' },
  selectedItem: {
    id: 'item-standard', key: 'standard-plan', name: 'Standard Plan',
    category: 'Service Plans', categoryKey: 'service-plans',
  },
  candidateItems: [{ id: 'item-premium', key: 'premium-plan', name: 'Premium Plan' }],
  pendingQuestion: { key: 'preferred_date', text: 'Which date?', kind: 'field' },
  language: 'ta',
  fields: { lead_name: 'Example Caller' },
  completedQuestions: ['lead_name'],
  answeredQuestions: ['Which option?'],
  activeActions: ['configured-booking'],
  recentTurns: [
    { role: 'user', content: 'Tell me about the standard option', at: 8 },
    { role: 'assistant', content: 'Approved option details', at: 9 },
  ],
  runningSummary: 'The caller selected the standard option.',
});
const restoredSnapshot = restorable.snapshot();
assert.equal(restoredSnapshot.currentStage, 'item_explanation');
assert.equal(restoredSnapshot.resumeStage, 'item_selection');
assert.equal(restoredSnapshot.activeCategory.key, 'service-plans');
assert.equal(restoredSnapshot.selectedItem.key, 'standard-plan');
assert.equal(restoredSnapshot.candidateItems[0].key, 'premium-plan');
assert.equal(restoredSnapshot.pendingQuestion, 'preferred_date');
assert.equal(restoredSnapshot.pendingQuestionText, 'Which date?');
assert.equal(restoredSnapshot.language, 'ta');
assert.deepEqual(restoredSnapshot.collectedData, { lead_name: 'Example Caller' });
assert.equal(restoredSnapshot.messages.length, 2);

const checkpoint = buildConversationMemoryState({
  call: { id: restorableIdentity.callId },
  history: restoredSnapshot.messages,
  callFrame: restoredSnapshot,
});
assert.equal(checkpoint.schemaVersion, 2);
assert.equal(checkpoint.callFrame.callId, restorableIdentity.callId);
assert.equal(checkpoint.callFrame.selectedItem.key, 'standard-plan');
assert.equal(checkpoint.callFrame.recentTurns.length, 2);
assert.deepEqual(checkpoint.callFrame.fields, { lead_name: 'Example Caller' });
assert.equal(activeLiveCallMemoryCount(), 5);

const maintenance = new LiveMemoryMaintenanceQueue({ callId: 'benchmark-call' });
let maintenanceRan = false;
const scheduleStartedAt = performance.now();
maintenance.schedule('test', async () => { maintenanceRan = true; });
const scheduleDurationMs = performance.now() - scheduleStartedAt;
assert.ok(scheduleDurationMs < 20, `Background scheduling blocked for ${scheduleDurationMs}ms`);
await maintenance.flush();
assert.equal(maintenanceRan, true);
assert.equal(maintenance.snapshot().completed, 1);
maintenance.close();

const hotPathSamples = [];
for (let index = 0; index < 250; index += 1) {
  const startedAt = performance.now();
  combined.captureUserUtterance(`Customer Name is Customer ${index}`);
  compactLiveCallMemoryContext({ snapshot: combined.snapshot(), collectedData: combined.snapshot().collectedData, missingFields: [] });
  hotPathSamples.push(performance.now() - startedAt);
}
hotPathSamples.sort((left, right) => left - right);
const p95Ms = hotPathSamples[Math.floor(hotPathSamples.length * 0.95)];
assert.ok(p95Ms < 50, `Live-memory hot-path p95 ${p95Ms}ms exceeded 50ms`);

session.close();
isolated.close();
namedDateSession.close();
combined.close();
restorable.close();
assert.equal(activeLiveCallMemoryCount(), 0);
console.log(`Live-call memory configuration, async maintenance, prompt limit and latency verified (p95 ${p95Ms.toFixed(2)}ms).`);
