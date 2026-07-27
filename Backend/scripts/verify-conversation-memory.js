import assert from 'node:assert/strict';
import {
  conversationContextHash,
  conversationMemoryScope,
  loadConversationMemory,
  saveConversationMemory,
} from '../src/voice/interaction/conversation-memory.service.js';
import { buildConversationMemoryState } from '../src/voice/interaction/conversation-memory-state.js';

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
});
assert.equal(state.recentMessages.length, 12);
assert.equal(state.recentMessages.at(-1).content, 'm19');
assert.equal(state.lastCall.id, 'call-2');

console.log(JSON.stringify({ success: true, task: 'Permanent PostgreSQL conversation memory' }));
