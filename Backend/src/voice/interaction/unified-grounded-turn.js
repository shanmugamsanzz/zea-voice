import { validateGroundedLlmDecision } from './grounded-llm-decision.js';
import { validateDecisionSecurity } from './grounded-decision-security.js';
import { validateGroundedClaims } from './grounded-claim-validator.js';
import {
  composeConfiguredTurnResponse,
  resolveNextConfiguredQuestion,
} from './next-question-policy.js';

function sourcesByType(sources = [], recordType) {
  const expected = String(recordType ?? '').toLocaleUpperCase();
  return sources.filter((source) => String(source?.recordType ?? '').toLocaleUpperCase() === expected);
}

function selectedSources(decision, groundingEnvelope, evidence) {
  const selected = new Set(decision.evidenceIds ?? []);
  const envelopeSources = (groundingEnvelope.sources ?? []).filter((source) => selected.has(source.id));
  return envelopeSources.map((source) => (
    evidence.find((candidate) => (
      candidate.id === source.id
      || (source.recordId && candidate.recordId === source.recordId)
    )) ?? source
  ));
}

/**
 * Applies one validated LLM decision to one generic call state. This module is
 * industry-neutral: all facts, questions, fields and tools come from the
 * published evidence or the existing UI configuration supplied by the caller.
 */
export function applyUnifiedGroundedTurn({
  rawDecision,
  groundingEnvelope,
  memory,
  turnToken,
  fieldSchemas = [],
  tools = [],
  evidence = [],
  evidenceScope = null,
  safetyPolicies = [],
} = {}) {
  if (!memory?.snapshot || !memory?.applyGroundedDecision) {
    throw new TypeError('A generic conversation memory instance is required');
  }
  const runtime = {
    fieldSchemas,
    toolSchemas: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? tool.configuration?.inputSchema
        ?? tool.configuration?.input_schema ?? { type: 'object', properties: {} },
    })),
    activeToolRequest: memory.snapshot().activeToolRequest,
  };
  const decision = validateGroundedLlmDecision(rawDecision, groundingEnvelope, runtime);
  if (!decision.valid) {
    return Object.freeze({ valid: false, reason: decision.reason, state: memory.snapshot() });
  }

  const claimValidation = validateGroundedClaims(
    decision.answer,
    selectedSources(decision, groundingEnvelope, evidence),
  );
  if (!claimValidation.valid) {
    return Object.freeze({
      valid: false, reason: claimValidation.reason, state: memory.snapshot(),
    });
  }

  const beforeState = memory.snapshot();
  const applied = memory.applyGroundedDecision(decision, { turnToken });
  if (applied?.stale) {
    return Object.freeze({ valid: false, reason: 'stale_turn', state: applied.state });
  }
  let afterState = memory.snapshot();
  const actionEvidence = sourcesByType(evidence, 'WORKFLOW_RULE');
  const security = validateDecisionSecurity({
    sources: selectedSources(decision, groundingEnvelope, evidence),
    toolRequest: decision.toolRequest,
    runtime: {
      answer: decision.answer,
      evidenceScope,
      toolSchemas: runtime.toolSchemas,
      actionEvidence,
      activeToolRequest: afterState.activeToolRequest,
      knownEntities: afterState.knownEntities,
      requireCurrentActionEvidence: decision.toolRequest !== null,
      safetyPolicies,
    },
  });
  if (!security.valid) {
    // Entity, topic and collected-information updates remain valid. An
    // unverified action request itself must not remain active in memory.
    if (decision.toolRequest || decision.activeToolRequest) {
      memory.setActiveToolRequest(null, { turnToken });
      afterState = memory.snapshot();
    }
    return Object.freeze({
      valid: false,
      reason: security.reason,
      evidenceIds: decision.evidenceIds,
      stateUpdate: decision.stateUpdate,
      toolRequest: null,
      state: afterState,
    });
  }
  const nextQuestion = resolveNextConfiguredQuestion({
    decision,
    beforeState,
    afterState,
    fieldSchemas,
    tools,
    actionEvidence,
    guidanceEvidence: sourcesByType(evidence, 'CONVERSATION_NODE'),
  });
  if (nextQuestion) {
    afterState = memory.setPendingQuestion({
      key: nextQuestion.key,
      text: nextQuestion.question,
      kind: nextQuestion.kind,
    });
    if (nextQuestion.activeToolRequest) {
      afterState = memory.setActiveToolRequest(nextQuestion.activeToolRequest, { turnToken });
    }
  }
  const answer = composeConfiguredTurnResponse(decision.answer, nextQuestion);
  if (answer) {
    memory.observeAssistantResponse?.(answer, { turnToken });
    memory.append?.({ role: 'assistant', content: answer }, { turnToken });
    afterState = memory.snapshot();
  }

  return Object.freeze({
    valid: true,
    decision: decision.decision,
    answer,
    evidenceIds: decision.evidenceIds,
    stateUpdate: decision.stateUpdate,
    pendingQuestion: afterState.pendingQuestion,
    nextQuestion,
    toolRequest: decision.toolRequest,
    state: afterState,
  });
}
