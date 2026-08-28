import { createKnowledgeEngineInput } from '../knowledge-engine/engine-contract.js';
import { selectCompleteConversationTurns } from '../knowledge-engine/conversation-turn-context.js';

export const NORMAL_TURN_CONTRACT_VERSION = 1;

export const groundedLlmOutputTypes = Object.freeze({
  RESPONSE: 'RESPONSE',
  TOOL: 'TOOL',
  CLARIFY: 'CLARIFY',
});

export const deterministicProtocolExceptionTypes = Object.freeze({
  SAFETY_EMERGENCY: 'SAFETY_EMERGENCY',
  EXPLICIT_HANGUP: 'EXPLICIT_HANGUP',
});

export const unifiedNormalTurnContract = Object.freeze({
  version: NORMAL_TURN_CONTRACT_VERSION,
  input: Object.freeze(['question', 'memory', 'scope']),
  output: Object.freeze(Object.values(groundedLlmOutputTypes)),
  deterministicProtocolExceptions: Object.freeze(
    Object.values(deterministicProtocolExceptionTypes),
  ),
});

const supportedOutputTypes = new Set(Object.values(groundedLlmOutputTypes));
const supportedProtocolExceptions = new Set(
  Object.values(deterministicProtocolExceptionTypes),
);

export function isDeterministicProtocolException(value) {
  return supportedProtocolExceptions.has(String(value ?? '').trim().toLocaleUpperCase());
}

function clean(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function required(value, label, maximum = 160) {
  const result = clean(value, maximum);
  if (!result) throw new TypeError(`Normal-turn ${label} is required`);
  return result;
}

function cleanDirection(value) {
  const direction = clean(value, 20).toLocaleLowerCase();
  if (!['inbound', 'outbound'].includes(direction)) {
    throw new TypeError('Normal-turn direction must be inbound or outbound');
  }
  return direction;
}

function entity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const recordId = clean(value.recordId ?? value.id, 160);
  const key = clean(value.key ?? value.itemKey ?? value.categoryKey, 160);
  const name = clean(value.name ?? value.label ?? value.category, 240);
  if (!recordId && !key && !name) return null;
  return Object.freeze({
    recordId: recordId || null,
    key: key || null,
    name: name || null,
    recordType: clean(value.recordType ?? value.type, 80) || null,
    category: clean(value.category, 240) || null,
    categoryKey: clean(value.categoryKey, 160) || null,
  });
}

function pending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = clean(value.kind, 80);
  const key = clean(value.key, 160);
  const text = clean(value.text, 500);
  return kind || key || text ? Object.freeze({
    kind: kind || null, key: key || null, text: text || null,
  }) : null;
}

function activeTool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = clean(value.name, 160);
  if (!name) return null;
  return Object.freeze({
    id: clean(value.id, 160) || null,
    name,
    status: clean(value.status, 80) || null,
    authorizationRecordId: clean(
      value.authorizationRecordId ?? value.authorizationEvidenceId, 160,
    ) || null,
    selectedEntityKey: clean(value.selectedEntityKey, 160) || null,
    selectedEntityName: clean(value.selectedEntityName, 240) || null,
    catalogRecordId: clean(value.catalogRecordId, 160) || null,
  });
}

function recentTurns(value, options = {}) {
  return Object.freeze(selectCompleteConversationTurns(value, options).map((turn) => Object.freeze({
    role: turn.role,
    content: clean(turn.content, 600),
  })).filter((turn) => turn.content));
}

function scalarFields(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.freeze(Object.fromEntries(Object.entries(source).flatMap(([key, fieldValue]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) return [];
    if (typeof fieldValue === 'boolean' || (typeof fieldValue === 'number' && Number.isFinite(fieldValue))) {
      return [[key, fieldValue]];
    }
    const normalized = clean(fieldValue, 500);
    return normalized ? [[key, normalized]] : [];
  })));
}

function toolFields(value) {
  const cleanValue = (fieldValue, depth = 0) => {
    if (depth > 4 || fieldValue === undefined) return undefined;
    if (fieldValue === null || typeof fieldValue === 'boolean') return fieldValue;
    if (typeof fieldValue === 'number') return Number.isFinite(fieldValue) ? fieldValue : undefined;
    if (typeof fieldValue === 'string') return clean(fieldValue, 1_000) || undefined;
    if (Array.isArray(fieldValue)) {
      return fieldValue.slice(0, 50).map((entry) => cleanValue(entry, depth + 1))
        .filter((entry) => entry !== undefined);
    }
    if (typeof fieldValue === 'object') {
      return Object.fromEntries(Object.entries(fieldValue).slice(0, 100).flatMap(([key, entry]) => {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key)) return [];
        const normalized = cleanValue(entry, depth + 1);
        return normalized === undefined ? [] : [[key, normalized]];
      }));
    }
    return undefined;
  };
  const normalized = cleanValue(value);
  return Object.freeze(normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized : {});
}

function validateMemoryScope(scope, memoryScope) {
  if (!memoryScope) return;
  for (const key of ['tenantId', 'agentId', 'callId']) {
    if (clean(memoryScope[key], 160).toLocaleLowerCase() !== scope[key].toLocaleLowerCase()) {
      throw new TypeError(`Normal-turn memory ${key} does not match the active call scope`);
    }
  }
}

export function createNormalTurnInput(value = {}) {
  const scope = Object.freeze({
    tenantId: required(value.tenantId, 'tenantId'),
    agentId: required(value.agentId, 'agentId'),
    callId: required(value.callId, 'callId'),
    usageDirection: cleanDirection(value.usageDirection ?? 'inbound'),
  });
  const finalizedQuestion = required(
    value.finalizedQuestion ?? value.currentQuestion ?? value.utterance,
    'finalized question', 2_000,
  );
  const sourceMemory = value.memory && typeof value.memory === 'object' ? value.memory : {};
  validateMemoryScope(scope, sourceMemory.scope);
  const facts = [...new Set((value.requestedFacts ?? sourceMemory.requestedFacts ?? [])
    .map((fact) => clean(fact, 120)).filter(Boolean))].slice(0, 10);
  const references = [...new Set((value.contextualReferences
    ?? sourceMemory.contextualReferences ?? []).map((reference) => clean(reference, 120))
    .filter(Boolean))].slice(0, 10);
  const conversationContextMode = clean(
    sourceMemory.conversationContextMode ?? 'last_n_turns', 40,
  ).toLocaleLowerCase();
  const conversationContextTurns = Math.max(1, Math.min(
    10, Number(sourceMemory.conversationContextTurns) || 5,
  ));
  const contextTerms = [
    sourceMemory.activeEntity?.name, sourceMemory.activeEntity?.key,
    sourceMemory.activeCategory?.name, sourceMemory.activeCategory?.key,
    value.requestedFact, ...facts,
  ].filter(Boolean);
  const memory = Object.freeze({
    scope: Object.freeze({
      tenantId: scope.tenantId, agentId: scope.agentId, callId: scope.callId,
    }),
    activeEntity: entity(sourceMemory.activeEntity),
    activeCategory: entity(sourceMemory.activeCategory),
    latestIntent: clean(sourceMemory.latestIntent ?? sourceMemory.requestType, 80) || null,
    requestedFact: clean(value.requestedFact ?? facts[0], 120) || null,
    requestedFacts: Object.freeze(facts),
    contextualReferences: Object.freeze(references),
    recentTurns: recentTurns(sourceMemory.recentTurns ?? sourceMemory.recentConversation, {
      mode: conversationContextMode,
      recentTurns: conversationContextTurns,
      currentQuestion: finalizedQuestion,
      contextTerms,
    }),
    conversationContextMode,
    conversationContextTurns,
    pendingClarification: pending(sourceMemory.pendingClarification),
    activeTool: activeTool(sourceMemory.activeTool ?? sourceMemory.activeToolRequest),
    collectedToolFields: scalarFields(
      sourceMemory.collectedToolFields ?? sourceMemory.collectedInformation,
    ),
  });
  return Object.freeze({
    contractVersion: NORMAL_TURN_CONTRACT_VERSION,
    scope,
    question: finalizedQuestion,
    // Compatibility aliases are read-only adapters for existing retrieval
    // modules. `question` is the single canonical contract field.
    finalizedQuestion,
    currentQuestion: finalizedQuestion,
    language: clean(value.language ?? sourceMemory.language ?? 'und', 20).toLocaleLowerCase() || 'und',
    memory,
    abortSignal: value.abortSignal ?? null,
  });
}

export function isNormalTurnInput(value) {
  return Boolean(value && value.contractVersion === NORMAL_TURN_CONTRACT_VERSION
    && value.scope?.tenantId && value.scope?.agentId && value.scope?.callId
    && value.question && value.memory?.scope);
}

export function toKnowledgeEngineInput(normalTurn) {
  if (!isNormalTurnInput(normalTurn)) throw new TypeError('A valid normal-turn input is required');
  return createKnowledgeEngineInput({
    tenantId: normalTurn.scope.tenantId,
    agentId: normalTurn.scope.agentId,
    callId: normalTurn.scope.callId,
    usageDirection: normalTurn.scope.usageDirection,
    utterance: normalTurn.question,
    language: normalTurn.language,
    requestedFacts: normalTurn.memory.requestedFacts,
    contextualReferences: normalTurn.memory.contextualReferences,
    recentRelevantTurns: normalTurn.memory.recentTurns,
    memory: normalTurn.memory,
    abortSignal: normalTurn.abortSignal,
  });
}

export function createGroundedLlmOutput(type, value = {}) {
  if (!supportedOutputTypes.has(type)) {
    throw new TypeError(`Unsupported grounded LLM output type: ${type}`);
  }
  const selectedEvidenceIds = Object.freeze([...new Set((value.selectedEvidenceIds ?? [])
    .map((id) => clean(id, 160)).filter(Boolean))]);
  const text = clean(value.text, 4_000) || null;
  const tool = type === groundedLlmOutputTypes.TOOL && value.tool
    ? Object.freeze({
      name: required(value.tool.name, 'tool name'),
      authorizationEvidenceId: required(
        value.tool.authorizationEvidenceId, 'tool authorization evidence',
      ),
      input: toolFields(value.tool.input),
    }) : null;
  if (type === groundedLlmOutputTypes.RESPONSE && (!text || !selectedEvidenceIds.length)) {
    throw new TypeError('RESPONSE requires caller-facing text and selected evidence');
  }
  if (type === groundedLlmOutputTypes.TOOL && !tool) {
    throw new TypeError('TOOL requires an authorized tool request');
  }
  if (type === groundedLlmOutputTypes.CLARIFY && !text) {
    throw new TypeError('CLARIFY requires a targeted caller-facing question');
  }
  return Object.freeze({
    contractVersion: NORMAL_TURN_CONTRACT_VERSION,
    origin: 'GROUNDED_LLM',
    type,
    text,
    selectedEvidenceIds,
    tool,
  });
}
