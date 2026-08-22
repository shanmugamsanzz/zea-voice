export const KNOWLEDGE_ENGINE_CONTRACT_VERSION = 1;

export const knowledgeEngineDecisionTypes = Object.freeze({
  DIRECT: 'DIRECT',
  LLM: 'LLM',
  TOOL: 'TOOL',
  CLARIFY: 'CLARIFY',
});

const decisionTypes = new Set(Object.values(knowledgeEngineDecisionTypes));
const clarificationKinds = new Set(['ambiguity', 'conflict', 'no_evidence', 'technical']);

function memoryObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.freeze({ ...value }) : null;
}

function memoryMessages(value) {
  return Object.freeze((Array.isArray(value) ? value : []).slice(-12).flatMap((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'user' ? 'user' : null);
    const content = String(message?.content ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 500);
    return role && content ? [Object.freeze({ role, content })] : [];
  }));
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
  return Object.freeze({
    contractVersion: KNOWLEDGE_ENGINE_CONTRACT_VERSION,
    tenantId,
    agentId,
    callId,
    utterance,
    usageDirection: String(value.usageDirection ?? 'inbound').trim().toLowerCase(),
    language: String(value.language ?? 'und').trim().toLowerCase().slice(0, 20) || 'und',
    requestedFacts: Object.freeze((Array.isArray(value.requestedFacts) ? value.requestedFacts : [])
      .map((item) => String(item ?? '').trim().slice(0, 120)).filter(Boolean).slice(0, 20)),
    memory: Object.freeze({
      activeEntity: memoryObject(suppliedMemory.activeEntity),
      activeCategory: memoryObject(suppliedMemory.activeCategory),
      latestIntent: String(suppliedMemory.latestIntent ?? suppliedMemory.requestType ?? '').trim().slice(0, 80) || null,
      recentConversation: memoryMessages(
        suppliedMemory.recentConversation ?? suppliedMemory.recentTurns,
      ),
      pendingClarification: memoryObject(suppliedMemory.pendingClarification),
      activeTool: memoryObject(suppliedMemory.activeTool ?? suppliedMemory.activeToolRequest),
      collectedToolFields: Object.freeze({
        ...(suppliedMemory.collectedToolFields ?? suppliedMemory.collectedInformation ?? {}),
      }),
      citedEvidence: evidenceMemory(suppliedMemory.citedEvidence),
      knownEntities: Object.freeze([...(Array.isArray(suppliedMemory.knownEntities)
        ? suppliedMemory.knownEntities : [])]),
      pendingQuestion: suppliedMemory.pendingQuestion ?? null,
      collectedInformation: Object.freeze({ ...(suppliedMemory.collectedInformation ?? {}) }),
    }),
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

  if (type === knowledgeEngineDecisionTypes.DIRECT && (!response || evidenceIds.length === 0)) {
    throw new TypeError('DIRECT requires caller-facing text and authoritative evidence');
  }
  if (type === knowledgeEngineDecisionTypes.LLM && evidenceIds.length === 0) {
    throw new TypeError('LLM requires published evidence');
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

  return Object.freeze({
    contractVersion: KNOWLEDGE_ENGINE_CONTRACT_VERSION,
    type,
    reason,
    confidence: boundedConfidence(options.confidence),
    evidenceIds,
    response: type === knowledgeEngineDecisionTypes.DIRECT ? response : null,
    tool: type === knowledgeEngineDecisionTypes.TOOL ? tool : null,
    clarification: type === knowledgeEngineDecisionTypes.CLARIFY
      ? Object.freeze({
        kind: clarificationKind,
        prompt: String(options.clarification?.prompt ?? '').trim() || null,
      }) : null,
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

export function technicalClarificationDecision(reason = 'engine_unavailable') {
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.CLARIFY, {
    reason, clarification: { kind: 'technical' },
  });
}

export function resolveKnowledgeEngineDecision({
  directResponse: selectedResponse = null, evidence = [], conflict = null,
  rejectedCandidates = 0, reasoningRequired = true, tool = null,
} = {}) {
  const relevant = evidence.filter((item) => item?.content || item?.authoritativeData);
  const top = relevant[0];
  const confidence = boundedConfidence(top?.semanticScore
    ?? top?.retrievalScore ?? top?.score ?? 0);
  const evidenceIds = uniqueIds(relevant.map((item) => item.id));

  if (conflict?.detected === true) return createKnowledgeEngineDecision(
    knowledgeEngineDecisionTypes.CLARIFY,
    {
      reason: conflict.type ?? 'conflicting_evidence', confidence, evidenceIds,
      clarification: { kind: 'conflict' },
    },
  );
  if (tool) return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.TOOL, {
    reason: 'authorized_tool_request', confidence, evidenceIds, tool,
  });
  if (selectedResponse) return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.DIRECT, {
    reason: 'strong_unambiguous_caller_response',
    confidence: Math.max(confidence, Number(selectedResponse.semanticScore ?? 0)),
    evidenceIds: uniqueIds(selectedResponse.deterministicEvidenceIds?.length
      ? selectedResponse.deterministicEvidenceIds : [selectedResponse.id]),
    response: {
      text: selectedResponse.content,
      recordId: selectedResponse.recordId,
      recordType: selectedResponse.recordType,
    },
  });
  if (relevant.length > 0 && reasoningRequired) {
    return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.LLM, {
      reason: 'reasoning_required', confidence, evidenceIds,
    });
  }
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.CLARIFY, {
    reason: relevant.length > 0
      ? 'deterministic_match_required'
      : (rejectedCandidates > 0 ? 'weak_evidence' : 'evidence_unavailable'),
    confidence, evidenceIds,
    clarification: { kind: relevant.length > 0 || rejectedCandidates > 0 ? 'ambiguity' : 'no_evidence' },
  });
}
