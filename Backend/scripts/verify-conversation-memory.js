import assert from 'node:assert/strict';
import {
  conversationContextHash,
  conversationMemoryScope,
  loadConversationMemory,
  saveConversationMemory,
} from '../src/voice/interaction/conversation-memory.service.js';
import { buildConversationMemoryState } from '../src/voice/interaction/conversation-memory-state.js';

const cleanState = buildConversationMemoryState({ previous: null, call: { id: 'call-null' } });
assert.equal(cleanState.callFrame.callId, null);
assert.deepEqual(cleanState.collectedData, {});

const contextId = 'customer:+919489974421';
assert.match(conversationContextHash(contextId), /^[a-f0-9]{64}$/);
assert.equal(conversationContextHash(contextId).includes('+919489974421'), false);

const scope = conversationMemoryScope({
  agent: { tenantId: 'tenant-1', workspaceId: 'workspace-1', id: 'agent-1' },
}, { contextId, source: 'phone_fallback' });
assert.equal(scope.tenantId, 'tenant-1');
assert.equal(scope.contextSource, 'phone_fallback');

const queries = [];
const row = {
  id: 'memory-1', tenant_id: 'tenant-1', workspace_id: 'workspace-1', agent_id: 'agent-1',
  context_hash: scope.contextHash, context_source: 'phone_fallback', memory_state: { summary: 'Known caller' },
  revision: 4, last_call_session_id: 'call-1', last_outcome: 'completed', last_call_at: new Date(),
  created_at: new Date(), updated_at: new Date(),
};
const contextRunner = async (operation) => operation({
  query: async (sql, values) => {
    queries.push({ sql, values });
    return { rows: [row], rowCount: 1 };
  },
});

const loaded = await loadConversationMemory(scope, { contextRunner });
assert.equal(loaded.state.summary, 'Known caller');
assert.deepEqual(queries[0].values, ['tenant-1', 'workspace-1', 'agent-1', scope.contextHash]);

const saved = await saveConversationMemory(scope, {
  state: { summary: 'Updated caller' }, callSessionId: 'call-1', outcome: 'completed',
}, { contextRunner });
assert.equal(saved.revision, 4);
assert.match(queries[1].sql, /ON CONFLICT\(tenant_id,workspace_id,agent_id,context_hash\)/);
assert.equal(queries[1].values[0], 'tenant-1');
assert.equal(queries[1].values[5].includes('Updated caller'), true);

const state = buildConversationMemoryState({
  previous: { recentMessages: [{ role: 'user', content: 'old' }] },
  history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` })),
  call: { id: 'call-2', direction: 'outbound' }, outcome: 'completed', reason: 'done',
  collectedData: { customer_name: 'Shanmugam' }, completedQuestions: ['customer_name'],
  pendingQuestions: ['preferred_date'], runningSummary: 'Customer selected a package.',
});
assert.equal(state.recentMessages.length, 12);
assert.equal(state.recentMessages.at(-1).content, 'm19');
assert.equal(state.lastCall.id, 'call-2');
assert.equal(state.collectedData.customer_name, 'Shanmugam');
assert.deepEqual(state.completedQuestions, ['customer_name']);
assert.deepEqual(state.pendingQuestions, ['preferred_date']);
assert.match(state.summary, /Customer selected a package/);

const liveState = buildConversationMemoryState({
  previous: {
    collectedData: { patient_name: 'Mitra' },
    callFrame: {
      callId: 'call-live', conversationStage: 'package_selection',
      activeCategory: { key: 'master', name: 'Master Health Checkup' },
      selectedItem: { id: 'silver-id', key: 'silver', name: 'Silver' },
      pendingQuestion: { key: 'patient_age', text: 'Age?', kind: 'field' },
      language: 'ta', fields: { patient_name: 'Mitra' },
    },
  },
  call: { id: 'call-live' },
  callFrame: { currentStage: 'booking_details', fields: { patient_age: '30' } },
  collectedData: { preferred_date: '2026-08-14' },
});
assert.equal(liveState.callFrame.currentStage, 'booking_details');
assert.equal(liveState.callFrame.activeCategory.key, 'master');
assert.equal(liveState.callFrame.selectedItem.key, 'silver');
assert.equal(liveState.callFrame.pendingQuestion.key, 'patient_age');
assert.equal(liveState.callFrame.language, 'ta');
assert.deepEqual(liveState.callFrame.fields, {
  patient_name: 'Mitra', patient_age: '30', preferred_date: '2026-08-14',
});
assert.deepEqual(liveState.collectedData, {
  patient_name: 'Mitra', patient_age: '30', preferred_date: '2026-08-14',
});

const clearedSelection = buildConversationMemoryState({
  previous: liveState,
  call: { id: 'call-live' },
  callFrame: {
    conversationStage: 'category_selection', selectedItem: null, pendingQuestion: null,
    activeCategory: { key: 'kids', name: 'Kids Health Packages' },
  },
});
assert.equal(clearedSelection.callFrame.currentStage, 'category_selection');
assert.deepEqual(clearedSelection.callFrame.selectedItem, {});
assert.equal(clearedSelection.callFrame.pendingQuestion.key, null);
assert.equal(clearedSelection.callFrame.activeCategory.key, 'kids');

console.log(JSON.stringify({ success: true, task: 'Permanent PostgreSQL conversation memory' }));
