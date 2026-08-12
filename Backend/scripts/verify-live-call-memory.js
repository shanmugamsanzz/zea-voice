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
isolated.append({ role: 'user', content: 'Company B', at: 8 });
assert.equal(isolated.snapshot().messages.length, 1);
assert.equal(session.snapshot().messages.some((entry) => entry.content === 'Company B'), false);
assert.equal(activeLiveCallMemoryCount(), 2);

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
assert.equal(activeLiveCallMemoryCount(), 3);

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
combined.close();
assert.equal(activeLiveCallMemoryCount(), 0);
console.log(`Live-call memory configuration, async maintenance, prompt limit and latency verified (p95 ${p95Ms.toFixed(2)}ms).`);
