import { selectCompleteConversationTurns } from '../../knowledge-engine/conversation-turn-context.js';

export const templateEngineStateKeys = Object.freeze([
  'recentCompleteTurns',
  'lastReferencedRecordIds',
  'comparisonRecordIds',
  'pendingClarification',
  'activeWorkflowId',
  'collectedToolFields',
  'confirmationStatus',
]);

const mutableStateKeys = new Set(templateEngineStateKeys.filter((key) => (
  key !== 'recentCompleteTurns'
)));

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function recordIds(value, maximum = 20) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.map((entry) => cleanText(
    entry && typeof entry === 'object' ? entry.recordId ?? entry.id : entry, 160,
  )).filter(Boolean))].slice(0, maximum));
}

function safeObject(value, maximumCharacters) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > maximumCharacters) return null;
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}

function workflowSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value.workflowState && typeof value.workflowState === 'object'
    && !Array.isArray(value.workflowState) ? value.workflowState : value;
}

export function createMinimalTemplateEngineState({
  conversationHistory = [],
  recentPairLimit = 5,
  lastReferencedRecordIds = [],
  comparisonRecordIds = [],
  pendingClarification = null,
  activeWorkflowId = null,
  activeWorkflowState = null,
  collectedToolFields = null,
  confirmationStatus = null,
} = {}) {
  const pairLimit = Math.max(3, Math.min(5, Number(recentPairLimit) || 5));
  const workflow = workflowSource(activeWorkflowState);
  const selectedRecord = workflow.selectedRecord && typeof workflow.selectedRecord === 'object'
    ? workflow.selectedRecord : {};
  const fields = collectedToolFields
    ?? workflow.collectedFields
    ?? activeWorkflowState?.collectedToolFields
    ?? {};
  return Object.freeze({
    recentCompleteTurns: Object.freeze(selectCompleteConversationTurns(conversationHistory, {
      mode: 'last_n_turns', recentTurns: pairLimit, maximumPairs: pairLimit,
    })),
    lastReferencedRecordIds: recordIds(lastReferencedRecordIds),
    comparisonRecordIds: recordIds(comparisonRecordIds, 10),
    pendingClarification: safeObject(pendingClarification, 4_000),
    activeWorkflowId: cleanText(
      activeWorkflowId
        ?? selectedRecord.recordId
        ?? activeWorkflowState?.authorizationRecordId
        ?? activeWorkflowState?.workflowRecordId,
      160,
    ) || null,
    collectedToolFields: safeObject(fields, 10_000) ?? Object.freeze({}),
    confirmationStatus: cleanText(
      confirmationStatus
        ?? workflow.confirmationStatus
        ?? activeWorkflowState?.confirmationStatus,
      40,
    ) || null,
  });
}

export function applyMinimalTemplateEngineStateUpdate(state, update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)
    || !update.set || typeof update.set !== 'object' || Array.isArray(update.set)
    || !Array.isArray(update.clear)) {
    throw new TypeError('A structured template-engine state update is required');
  }
  const requestedKeys = [...Object.keys(update.set), ...update.clear];
  if (requestedKeys.some((key) => !mutableStateKeys.has(key))) {
    throw new TypeError('The template-engine state update contains an unsupported field');
  }
  const next = { ...state, ...update.set };
  for (const key of update.clear) next[key] = null;
  return createMinimalTemplateEngineState({
    conversationHistory: state?.recentCompleteTurns ?? [],
    recentPairLimit: 5,
    lastReferencedRecordIds: next.lastReferencedRecordIds ?? [],
    comparisonRecordIds: next.comparisonRecordIds ?? [],
    pendingClarification: next.pendingClarification,
    activeWorkflowId: next.activeWorkflowId,
    collectedToolFields: next.collectedToolFields,
    confirmationStatus: next.confirmationStatus,
  });
}

