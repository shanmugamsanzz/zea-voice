import { selectCompleteConversationTurns } from './conversation-turn-context.js';

export const KNOWLEDGE_ENGINE_CONTRACT_VERSION = 2;

export const knowledgeEngineOutputTypes = Object.freeze({
  RESPONSE: 'RESPONSE',
  TOOL: 'TOOL',
  CLARIFY: 'CLARIFY',
});

export const knowledgeEngineDecisionTypes = knowledgeEngineOutputTypes;

export const knowledgeEngineResponseModes = Object.freeze({
  DETERMINISTIC: 'DETERMINISTIC',
  GROUNDED_LLM: 'GROUNDED_LLM',
});

const decisionTypes = new Set(Object.values(knowledgeEngineDecisionTypes));
const responseModes = new Set(Object.values(knowledgeEngineResponseModes));
const clarificationKinds = new Set(['ambiguity', 'conflict', 'no_evidence', 'technical']);

function cleanString(value, maximum = 120) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function stringList(value, maximumItems = 20, maximumCharacters = 120) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : [])
    .map((item) => cleanString(item, maximumCharacters)).filter(Boolean))].slice(0, maximumItems));
}

function memoryObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.freeze({ ...value }) : null;
}

function memoryMessages(value) {
  return Object.freeze(selectCompleteConversationTurns(value, {
    recentTurns: 10, maximumPairs: 10,
  }).map((message) => Object.freeze({
    role: message.role,
    content: String(message.content ?? '').normalize('NFKC')
      .replace(/\s+/gu, ' ').trim().slice(0, 500),
  })).filter((message) => message.content));
}

function evidenceMemory(value) {
  return Object.freeze((Array.isArray(value) ? value : []).slice(-20).flatMap((source) => {
    const object = source && typeof source === 'object' ? source : { id: source };
    const id = String(object.id ?? '').trim().slice(0, 160);
    return id ? [Object.freeze({
      id,
      recordId: object.recordId ? String(object.recordId).slice(0, 160) : null,
      recordType: object.recordType ? String(object.recordType).slice(0, 80) : null,
    })] : [];
  }));
}

export function createKnowledgeEngineInput(value = {}) {
  const tenantId = String(value.tenantId ?? '').trim();
  const agentId = String(value.agentId ?? '').trim();
  const callId = String(value.callId ?? '').trim();
  const utterance = String(value.utterance ?? '').normalize('NFKC').trim().slice(0, 2_000);
  if (!tenantId || !agentId || !callId || !utterance) {
    throw new TypeError('Knowledge-engine input requires tenant, agent, call and finalized utterance');
  }
  const suppliedMemory = value.memory && typeof value.memory === 'object' ? value.memory : {};
  // These describe the latest finalized question. Historical values remain in
  // canonical memory but must not silently classify a new caller turn.
  const requestedFacts = stringList(value.requestedFacts);
  const contextualReferences = stringList(value.contextualReferences);
  const recentRelevantTurns = memoryMessages(
    value.recentRelevantTurns
      ?? suppliedMemory.recentRelevantTurns
      ?? suppliedMemory.recentConversation
      ?? suppliedMemory.recentTurns,
  );
  const canonicalCallMemory = Object.freeze({
    activeEntity: memoryObject(suppliedMemory.activeEntity),
    activeCategory: memoryObject(suppliedMemory.activeCategory),
    latestIntent: cleanString(suppliedMemory.latestIntent ?? suppliedMemory.requestType, 80) || null,
    recentConversation: recentRelevantTurns,
    conversationContextMode: cleanString(
      suppliedMemory.conversationContextMode ?? 'last_n_turns', 40,
    ).toLocaleLowerCase(),
    conversationContextTurns: Math.max(1, Math.min(
      10, Number(suppliedMemory.conversationContextTurns) || 5,
    )),
    pendingClarification: memoryObject(
      suppliedMemory.pendingClarification ?? suppliedMemory.pendingQuestion,
    ),
    activeTool: memoryObject(suppliedMemory.activeTool ?? suppliedMemory.activeToolRequest),
    collectedToolFields: Object.freeze({
      ...(suppliedMemory.collectedToolFields ?? suppliedMemory.collectedInformation ?? {}),
    }),
    citedEvidence: evidenceMemory(suppliedMemory.citedEvidence),
    knownEntities: Object.freeze([...(Array.isArray(suppliedMemory.knownEntities)
      ? suppliedMemory.knownEntities : [])]),
    comparisonEntities: Object.freeze([...(Array.isArray(suppliedMemory.comparisonEntities)
      ? suppliedMemory.comparisonEntities : [])].slice(0, 5)),
    pendingQuestion: suppliedMemory.pendingQuestion ?? null,
    collectedInformation: Object.freeze({ ...(suppliedMemory.collectedInformation ?? {}) }),
    latestCallerQuestion: cleanString(
      suppliedMemory.latestCallerQuestion ?? utterance, 2_000,
    ) || utterance,
    correctedFields: stringList(suppliedMemory.correctedFields, 30, 64),
    requestedFacts,
    contextualReferences,
  });
  return Object.freeze({
    contractVersion: KNOWLEDGE_ENGINE_CONTRACT_VERSION,
    tenantId,
    agentId,
    callId,
    utterance,
    latestQuestion: utterance,
    usageDirection: String(value.usageDirection ?? 'inbound').trim().toLowerCase(),
    language: String(value.language ?? 'und').trim().toLowerCase().slice(0, 20) || 'und',
    requestedFact: requestedFacts[0] ?? null,
    requestedFacts,
    contextualReferences,
    recentRelevantTurns,
    canonicalCallMemory,
    memory: canonicalCallMemory,
    queryUnderstanding: memoryObject(value.queryUnderstanding),
    abortSignal: value.abortSignal ?? null,
  });
}

export function isKnowledgeEngineInput(value) {
  return Boolean(value && typeof value === 'object'
    && value.contractVersion === KNOWLEDGE_ENGINE_CONTRACT_VERSION
    && String(value.tenantId ?? '').trim()
    && String(value.agentId ?? '').trim()
    && String(value.callId ?? '').trim()
    && String(value.utterance ?? '').trim());
}

function boundedConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function uniqueIds(values) {
  return Object.freeze([...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim()).filter(Boolean))]);
}

function directResponse(value) {
  if (!value || typeof value !== 'object') return null;
  const text = String(value.text ?? value.content ?? '').trim();
  if (!text) return null;
  return Object.freeze({
    text,
    recordId: value.recordId ? String(value.recordId) : null,
    recordType: value.recordType ? String(value.recordType) : null,
  });
}

function toolRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name ?? '').trim();
  if (!name) return null;
  return Object.freeze({
    name,
    authorizationEvidenceId: value.authorizationEvidenceId
      ? String(value.authorizationEvidenceId) : null,
    input: value.input && typeof value.input === 'object' && !Array.isArray(value.input)
      ? Object.freeze({ ...value.input }) : Object.freeze({}),
  });
}

export function createKnowledgeEngineDecision(type, options = {}) {
  if (!decisionTypes.has(type)) throw new TypeError(`Unsupported knowledge-engine decision: ${type}`);
  const reason = String(options.reason ?? '').trim();
  if (!reason) throw new TypeError('Knowledge-engine decision requires a reason');
  const evidenceIds = uniqueIds(options.evidenceIds);
  const response = directResponse(options.response);
  const tool = toolRequest(options.tool);
  const clarificationKind = String(options.clarification?.kind ?? '').trim();
  const mode = type === knowledgeEngineDecisionTypes.RESPONSE
    ? String(options.mode ?? (response
      ? knowledgeEngineResponseModes.DETERMINISTIC
      : knowledgeEngineResponseModes.GROUNDED_LLM)).trim()
    : null;

  if (type === knowledgeEngineDecisionTypes.RESPONSE
    && (!responseModes.has(mode) || evidenceIds.length === 0)) {
    throw new TypeError('RESPONSE requires a supported mode and authoritative evidence');
  }
  if (type === knowledgeEngineDecisionTypes.RESPONSE
    && mode === knowledgeEngineResponseModes.DETERMINISTIC && !response) {
    throw new TypeError('A deterministic RESPONSE requires validated caller-facing text');
  }
  if (type === knowledgeEngineDecisionTypes.TOOL
    && (!tool || !tool.authorizationEvidenceId
      || !evidenceIds.includes(tool.authorizationEvidenceId))) {
    throw new TypeError('TOOL requires a request authorized by selected Workflow evidence');
  }
  if (type === knowledgeEngineDecisionTypes.CLARIFY
    && !clarificationKinds.has(clarificationKind)) {
    throw new TypeError('CLARIFY requires a supported clarification kind');
  }

  const normalizedClarification = type === knowledgeEngineDecisionTypes.CLARIFY
    ? Object.freeze({
      kind: clarificationKind,
      prompt: String(options.clarification?.prompt ?? '').trim() || null,
    }) : null;
  const normalizedResponse = type === knowledgeEngineDecisionTypes.RESPONSE ? response : null;
  const normalizedTool = type === knowledgeEngineDecisionTypes.TOOL ? tool : null;
  return Object.freeze({
    contractVersion: KNOWLEDGE_ENGINE_CONTRACT_VERSION,
    type,
    mode,
    reason,
    confidence: boundedConfidence(options.confidence),
    evidenceIds,
    response: normalizedResponse,
    tool: normalizedTool,
    clarification: normalizedClarification,
  });
}

export function isKnowledgeEngineDecision(value) {
  if (!value || typeof value !== 'object'
    || value.contractVersion !== KNOWLEDGE_ENGINE_CONTRACT_VERSION
    || !decisionTypes.has(value.type)
    || typeof value.reason !== 'string'
    || !Array.isArray(value.evidenceIds)) return false;
  try {
    createKnowledgeEngineDecision(value.type, value);
    return true;
  } catch {
    return false;
  }
}
