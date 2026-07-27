import crypto from 'node:crypto';
import { withAuthServiceContext } from '../../infrastructure/database-context.js';
import { normalizeConversationMemoryState } from './conversation-memory-state.js';

export function conversationContextHash(contextId) {
  return crypto.createHash('sha256').update(String(contextId ?? '')).digest('hex');
}

export function conversationMemoryScope(runtimeProfile, contextResolution) {
  const scope = {
    tenantId: runtimeProfile?.agent?.tenantId,
    workspaceId: runtimeProfile?.agent?.workspaceId,
    agentId: runtimeProfile?.agent?.id,
    contextHash: conversationContextHash(contextResolution?.contextId),
    contextSource: contextResolution?.source ?? 'unknown',
  };
  for (const [field, value] of Object.entries(scope).slice(0, 3)) {
    if (!value) throw new TypeError(`${field} is required for conversation memory`);
  }
  if (!contextResolution?.contextId) throw new TypeError('contextId is required for conversation memory');
  return Object.freeze(scope);
}

function map(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    contextHash: row.context_hash,
    contextSource: row.context_source,
    state: normalizeConversationMemoryState(row.memory_state),
    revision: Number(row.revision),
    lastCallSessionId: row.last_call_session_id,
    lastOutcome: row.last_outcome,
    lastCallAt: row.last_call_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function loadConversationMemory(scope, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner(async (client) => {
    const result = await client.query(`SELECT * FROM conversation_memories
      WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3 AND context_hash=$4`, [
      scope.tenantId, scope.workspaceId, scope.agentId, scope.contextHash,
    ]);
    return map(result.rows[0]);
  });
}

export function saveConversationMemory(scope, input, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  const state = normalizeConversationMemoryState(input.state);
  return contextRunner(async (client) => {
    const result = await client.query(`INSERT INTO conversation_memories
      (tenant_id,workspace_id,agent_id,context_hash,context_source,memory_state,
       last_call_session_id,last_outcome,last_call_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
      ON CONFLICT(tenant_id,workspace_id,agent_id,context_hash) DO UPDATE SET
        context_source=EXCLUDED.context_source,memory_state=EXCLUDED.memory_state,
        last_call_session_id=EXCLUDED.last_call_session_id,last_outcome=EXCLUDED.last_outcome,
        last_call_at=EXCLUDED.last_call_at,revision=conversation_memories.revision+1
      RETURNING *`, [
      scope.tenantId, scope.workspaceId, scope.agentId, scope.contextHash,
      scope.contextSource, JSON.stringify(state), input.callSessionId ?? null,
      input.outcome ?? null, input.at ?? new Date(),
    ]);
    return map(result.rows[0]);
  });
}

export const conversationMemoryRepository = Object.freeze({
  load: loadConversationMemory,
  save: saveConversationMemory,
});

