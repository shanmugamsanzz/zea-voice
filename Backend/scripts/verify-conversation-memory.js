import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  conversationContextHash,
  conversationMemoryScope,
  loadConversationMemory,
  saveConversationMemory,
} from '../src/voice/interaction/conversation-memory.service.js';
import { buildConversationMemoryState } from '../src/voice/interaction/conversation-memory-state.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';

const cleanState = buildConversationMemoryState({ previous: null, call: { id: 'call-null' } });
assert.deepEqual(Object.keys(cleanState.callFrame).sort(), [
  'activeCategory', 'activeEntity', 'activeTool', 'citedEvidence', 'collectedToolFields',
  'latestIntent', 'memoryVersion', 'pendingClarification', 'scope',
  'activeToolRequest', 'collectedInformation', 'currentTopic', 'knownEntities',
  'language', 'lastAnswer', 'pendingQuestion', 'recentTurns',
  'comparisonEntities', 'correctedFields', 'latestCallerQuestion',
].sort());
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
assert.equal(state.recentMessages.length, 21);
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
assert.deepEqual(liveState.callFrame.knownEntities, [],
  'stale selectedItem aliases must not be converted into canonical entity memory');
assert.equal(liveState.callFrame.pendingQuestion.key, 'patient_age');
assert.equal(liveState.callFrame.language, 'ta');
assert.deepEqual(liveState.callFrame.collectedInformation, {
  patient_name: 'Mitra', patient_age: '30', preferred_date: '2026-08-14',
});
assert.deepEqual(liveState.collectedData, {
  patient_name: 'Mitra', patient_age: '30', preferred_date: '2026-08-14',
});

const clearedSelection = buildConversationMemoryState({
  previous: liveState,
  call: { id: 'call-live' },
  callFrame: {
    currentTopic: 'Kids Health Packages', pendingQuestion: null,
    knownEntities: [{ key: 'kids', name: 'Kids Health Packages' }],
  },
});
assert.equal(clearedSelection.callFrame.currentTopic, 'Kids Health Packages');
assert.equal(clearedSelection.callFrame.knownEntities[0].key, 'kids');
assert.equal(clearedSelection.callFrame.pendingQuestion.key, null);

const priorTurns = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
];
const recentMemory = openGenericConversationState({
  tenantId: 'tenant-1', agentId: 'agent-1', callId: 'call-recent',
}, { conversationContextMode: 'last_n_turns', conversationContextTurns: 1 }, 0,
{ recentTurns: priorTurns });
assert.deepEqual(recentMemory.promptMessages().map(({ content }) => content),
  ['second question', 'second answer']);
recentMemory.close();
const fullMemory = openGenericConversationState({
  tenantId: 'tenant-1', agentId: 'agent-1', callId: 'call-full',
}, { conversationContextMode: 'full_current_call', conversationContextTurns: 1 }, 0,
{ recentTurns: priorTurns });
assert.equal(fullMemory.promptMessages().length, priorTurns.length);
fullMemory.close();

const orchestrator = await readFile(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');
assert.match(orchestrator,
  /restoredMemory\s*=\s*this\.contextCachePolicy\.crossCall[\s\S]*previousConversationMemory\?\.callFrame/u,
  'Persistent UI policy must authorize previous-call restoration');
assert.match(orchestrator,
  /conversationHistory:\s*this\.liveCallMemory\?\.promptMessages\?\.\(\)\s*\?\?\s*history/u,
  'The LLM must receive conversation history bounded by the UI memory configuration');

console.log(JSON.stringify({ success: true, task: 'Permanent PostgreSQL conversation memory' }));
