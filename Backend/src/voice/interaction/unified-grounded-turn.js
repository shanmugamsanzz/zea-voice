import { validateGroundedLlmDecision } from './grounded-llm-decision.js';
import {
  configuredToolAuthorization,
  validateDecisionSecurity,
} from './grounded-decision-security.js';
import {
  hydrateSelectedEvidence,
  hydrateGroundingEnvelope,
  validateCallerProvidedState,
  validateGroundedClaims,
} from './grounded-claim-validator.js';
import {
  composeConfiguredTurnResponse,
  resolveNextConfiguredQuestion,
} from './next-question-policy.js';

function sourcesByType(sources = [], recordType) {
  const expected = String(recordType ?? '').toLocaleUpperCase();
  return sources.filter((source) => String(source?.recordType ?? '').toLocaleUpperCase() === expected);
}

function selectedSources(decision, groundingEnvelope, evidence) {
  // Discovery snippets are not authoritative facts.  Resolve every cited ID
  // back to the complete PostgreSQL-hydrated source, or reject the decision.
  return hydrateSelectedEvidence(decision, groundingEnvelope, evidence);
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
  finalizedUtterance = '',
  confirmationConfiguration = null,
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
  const hydratedEnvelope = hydrateGroundingEnvelope(groundingEnvelope, evidence);
  const decision = validateGroundedLlmDecision(rawDecision, hydratedEnvelope, runtime);
  if (!decision.valid) {
    return Object.freeze({ valid: false, reason: decision.reason, state: memory.snapshot() });
  }

  const beforeState = memory.snapshot();
  const callerStateValidation = validateCallerProvidedState(
    decision.stateUpdate, finalizedUtterance, beforeState,
  );
  if (!callerStateValidation.valid) {
    return Object.freeze({
      valid: false, reason: callerStateValidation.reason,
      field: callerStateValidation.field, state: beforeState,
    });
  }
  const claimValidation = validateGroundedClaims(
    decision.answer,
    selectedSources(decision, hydratedEnvelope, evidence),
    { knownEntities: hydratedEnvelope.entities },
  );
  if (!claimValidation.valid) {
    return Object.freeze({
      valid: false, reason: claimValidation.reason, state: memory.snapshot(),
    });
  }

  const applied = memory.applyGroundedDecision(decision, { turnToken });
  if (applied?.stale) {
    return Object.freeze({ valid: false, reason: 'stale_turn', state: applied.state });
  }
  let afterState = memory.snapshot();
  const actionEvidence = sourcesByType(evidence, 'WORKFLOW_RULE');
  const selectedEvidence = selectedSources(decision, hydratedEnvelope, evidence);
  const requestedToolName = decision.toolRequest?.name ?? afterState.activeToolRequest?.name;
  const exactSelectedEntities = decision.stateUpdate.knownEntities.length
    ? decision.stateUpdate.knownEntities
    : (afterState.knownEntities.length === 1 ? afterState.knownEntities : []);
  let actionContext = null;
  if (requestedToolName) {
    actionContext = configuredToolAuthorization(requestedToolName, {
      evidenceScope,
      toolSchemas: runtime.toolSchemas,
      actionEvidence,
      catalogEvidence: sourcesByType(selectedEvidence, 'CATALOG_ITEM'),
      selectedEntities: exactSelectedEntities,
      activeToolRequest: beforeState.activeToolRequest,
      requireCurrentActionEvidence: !beforeState.activeToolRequest?.authorizationRecordId,
    });
    if (!actionContext.valid) {
      memory.setActiveToolRequest(null, { turnToken });
      return Object.freeze({
        valid: false,
        reason: actionContext.reason === 'exact_selectable_catalog_item_required'
          ? actionContext.reason : 'unauthorized_tool_request',
        toolRequest: null,
        evidenceIds: decision.evidenceIds, stateUpdate: decision.stateUpdate,
        state: memory.snapshot(),
      });
    }
    const activeRequest = {
      id: afterState.activeToolRequest?.id ?? null,
      name: actionContext.tool.name,
      status: beforeState.activeToolRequest?.status === 'awaiting_confirmation'
        ? 'awaiting_confirmation' : 'collecting_information',
      authorizationRecordId: actionContext.authorizationRecordId,
      ...(actionContext.catalogItem ? {
        selectedEntityKey: actionContext.catalogItem.key,
        selectedEntityName: actionContext.catalogItem.name,
        catalogRecordId: actionContext.catalogItem.recordId,
      } : {}),
    };
    afterState = memory.setActiveToolRequest(activeRequest, { turnToken });
    if (actionContext.catalogItem && confirmationConfiguration?.catalogField) {
      afterState = memory.mergeCollectedData({
        [confirmationConfiguration.catalogField]: actionContext.catalogItem.name,
      });
    }
  }
  const confirmationRequired = confirmationConfiguration?.enabled === true
    && requestedToolName
    && String(confirmationConfiguration.intent ?? '').normalize('NFKC').toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
      === String(requestedToolName).normalize('NFKC').toLocaleLowerCase()
        .replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  const security = validateDecisionSecurity({
    sources: selectedEvidence,
    toolRequest: decision.toolRequest,
    runtime: {
      answer: decision.answer,
      evidenceScope,
      toolSchemas: runtime.toolSchemas,
      actionEvidence,
      catalogEvidence: sourcesByType(selectedEvidence, 'CATALOG_ITEM'),
      selectedEntities: exactSelectedEntities,
      activeToolRequest: beforeState.activeToolRequest?.authorizationRecordId
        ? beforeState.activeToolRequest : afterState.activeToolRequest,
      knownEntities: afterState.knownEntities,
      collectedInformation: afterState.collectedInformation,
      configuredFieldKeys: fieldSchemas.map((field) => field.key),
      confirmationRequired,
      requireCurrentActionEvidence: decision.toolRequest !== null
        && !beforeState.activeToolRequest?.authorizationRecordId,
      safetyPolicies,
    },
  });
  const awaitingConfirmation = security.reason === 'confirmation_required' && actionContext?.valid;
  if (!security.valid) {
    // Entity, topic and collected-information updates remain valid. An
    // unverified action request itself must not remain active in memory.
    if (awaitingConfirmation) {
      afterState = memory.setActiveToolRequest({
        ...afterState.activeToolRequest,
        status: 'collecting_information',
      }, { turnToken });
    } else if (decision.toolRequest || decision.activeToolRequest) {
      memory.setActiveToolRequest(null, { turnToken });
      afterState = memory.snapshot();
    }
    if (awaitingConfirmation) {
      // The same-turn fields and Catalog selection remain committed, but the
      // external operation is suppressed until a later confirmed turn.
    } else {
    return Object.freeze({
      valid: false,
      reason: security.reason,
      evidenceIds: decision.evidenceIds,
      stateUpdate: decision.stateUpdate,
      toolRequest: null,
      state: afterState,
    });
    }
  }
  const nextQuestion = resolveNextConfiguredQuestion({
    decision,
    beforeState,
    afterState,
    fieldSchemas,
    tools,
    actionEvidence,
    guidanceEvidence: sourcesByType(evidence, 'CONVERSATION_NODE'),
    confirmationConfiguration,
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
    toolRequest: awaitingConfirmation ? null : decision.toolRequest,
    state: afterState,
  });
}
