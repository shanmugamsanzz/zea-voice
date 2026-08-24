import {
  activeGenericConversationStateCount,
  compactGenericConversationState,
  isolatedCallMemoryKey,
  openGenericConversationState,
  seedConfiguredQuestion as seedGenericConfiguredQuestion,
} from '../voice/interaction/generic-conversation-state.js';

export const KNOWLEDGE_CALL_MEMORY_VERSION = 1;

export function knowledgeCallMemoryKey(identity = {}) {
  return isolatedCallMemoryKey({
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    callId: identity.callId,
  });
}

export function openIsolatedCallMemory(identity, settings = {}, now = Date.now(), initial = {}) {
  const scopedIdentity = Object.freeze({
    tenantId: String(identity?.tenantId ?? '').trim(),
    agentId: String(identity?.agentId ?? '').trim(),
    callId: String(identity?.callId ?? '').trim(),
  });
  knowledgeCallMemoryKey(scopedIdentity);
  // Only a frame explicitly belonging to this call may be restored. This
  // prevents a durable customer context from becoming mutable call state.
  const initialFrame = initial?.scope?.callId === scopedIdentity.callId ? initial : {};
  return openGenericConversationState(scopedIdentity, settings, now, initialFrame);
}

export function compactIsolatedCallMemory(snapshot = {}, maximumCharacters = 1_000) {
  return compactGenericConversationState(snapshot, maximumCharacters);
}

export function activeIsolatedCallMemoryCount() {
  return activeGenericConversationStateCount();
}

export function seedConfiguredQuestion(memory, message, key) {
  return seedGenericConfiguredQuestion(memory, message, key);
}
