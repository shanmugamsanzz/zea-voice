import { validateGroundedLlmDecision } from './grounded-llm-decision.js';
import {
  configuredToolAuthorization,
  evidenceBelongsToRuntime,
  validateDecisionSecurity,
} from './grounded-decision-security.js';
import {
  hydrateGroundingEnvelope,
  validateCallerProvidedState,
  validateGroundedClaims,
} from './grounded-claim-validator.js';
import {
  composeConfiguredTurnResponse,
  resolveNextConfiguredQuestion,
  validateConfiguredFieldCollectionSpeech,
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

function identity(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function entitySupportedBySelectedCatalog(entity, selectedEvidence) {
  const requested = new Set([entity?.id, entity?.key, entity?.name].map(identity).filter(Boolean));
  return selectedEvidence.some((source) => {
    if (String(source?.recordType ?? '').toLocaleUpperCase() !== 'CATALOG_ITEM') return false;
    const data = source.authoritativeData ?? {};
    return [source.recordId, data.itemKey, data.name].map(identity)
      .filter(Boolean).some((candidate) => requested.has(candidate));
  });
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
  const exactPublishedResponse = decision.evidenceIds.some((id) => (
    (hydratedEnvelope.exactCallerResponses ?? []).includes(id)
  ));
  const explicitLatestTopic = decision.stateUpdate.contextDependent !== true
    && !beforeState.activeToolRequest
    && decision.stateUpdate.knownEntities.length > 0;
  // An exact overview/message already contains its configured next question.
  // A specific new topic also completes any stale introduction/overview
  // prompt. Relevant guidance can still supply the next current question.
  const effectiveDecision = exactPublishedResponse || explicitLatestTopic
    ? Object.freeze({
      ...decision,
      pendingQuestion: null,
      pendingQuestionRelevant: false,
      stateUpdate: Object.freeze({ ...decision.stateUpdate, pendingQuestionRelevant: false }),
    })
    : decision;
  const callerStateValidation = validateCallerProvidedState(
    effectiveDecision.stateUpdate, finalizedUtterance, beforeState,
  );
  if (!callerStateValidation.valid) {
    return Object.freeze({
      valid: false, reason: callerStateValidation.reason,
      field: callerStateValidation.field, state: beforeState,
    });
  }
  const selectedEvidence = selectedSources(effectiveDecision, hydratedEnvelope, evidence);
  if (selectedEvidence.some((source) => !evidenceBelongsToRuntime(source, evidenceScope))) {
    return Object.freeze({
      valid: false, reason: 'foreign_evidence_selected', state: memory.snapshot(),
    });
  }
  if (effectiveDecision.stateUpdate.knownEntities.some((entity) => (
    !entitySupportedBySelectedCatalog(entity, selectedEvidence)
  ))) {
    return Object.freeze({
      valid: false, reason: 'unsupported_selected_entity', state: beforeState,
    });
  }
  const actionEvidence = sourcesByType(evidence, 'WORKFLOW_RULE');
  const exactSelectedEntities = effectiveDecision.stateUpdate.knownEntities.length
    ? effectiveDecision.stateUpdate.knownEntities
    : (beforeState.knownEntities?.length === 1 ? beforeState.knownEntities : []);
  const proposedToolName = effectiveDecision.toolRequest?.name
    ?? effectiveDecision.stateUpdate.activeToolRequest?.name
    ?? beforeState.activeToolRequest?.name;
  const preliminaryAction = proposedToolName ? configuredToolAuthorization(proposedToolName, {
    evidenceScope,
    toolSchemas: runtime.toolSchemas,
    actionEvidence,
    catalogEvidence: sourcesByType(selectedEvidence, 'CATALOG_ITEM'),
    selectedEntities: exactSelectedEntities,
    activeToolRequest: beforeState.activeToolRequest,
    requireCurrentActionEvidence: !beforeState.activeToolRequest?.authorizationRecordId,
  }) : null;
  const fieldCollection = validateConfiguredFieldCollectionSpeech(
    [effectiveDecision.answer, effectiveDecision.pendingQuestion].filter(Boolean).join(' '),
    {
      fieldSchemas,
      activeToolAuthorized: preliminaryAction?.valid === true,
    },
  );
  if (!fieldCollection.valid) {
    return Object.freeze({
      valid: false, reason: fieldCollection.reason, field: fieldCollection.field, state: beforeState,
    });
  }
  const claimValidation = validateGroundedClaims(
    effectiveDecision.answer,
    selectedEvidence,
    { knownEntities: hydratedEnvelope.entities },
  );
  if (!claimValidation.valid) {
    return Object.freeze({
      valid: false, reason: claimValidation.reason, state: memory.snapshot(),
    });
  }

  const applied = memory.applyGroundedDecision(effectiveDecision, { turnToken });
  if (applied?.stale) {
    return Object.freeze({ valid: false, reason: 'stale_turn', state: applied.state });
  }
  let afterState = memory.snapshot();
  const requestedToolName = effectiveDecision.toolRequest?.name ?? afterState.activeToolRequest?.name;
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
        evidenceIds: effectiveDecision.evidenceIds, stateUpdate: effectiveDecision.stateUpdate,
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
    toolRequest: effectiveDecision.toolRequest,
    runtime: {
      answer: effectiveDecision.answer,
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
      requireCurrentActionEvidence: effectiveDecision.toolRequest !== null
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
    } else if (effectiveDecision.toolRequest || effectiveDecision.activeToolRequest) {
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
      evidenceIds: effectiveDecision.evidenceIds,
      stateUpdate: effectiveDecision.stateUpdate,
      toolRequest: null,
      state: afterState,
    });
    }
  }
  const nextQuestion = effectiveDecision.responseId ? null : resolveNextConfiguredQuestion({
    decision: effectiveDecision,
    beforeState,
    afterState,
    fieldSchemas,
    tools,
    actionEvidence,
    guidanceEvidence: sourcesByType(evidence, 'CONVERSATION_NODE'),
    confirmationConfiguration,
  });
  const nextQuestionValidation = validateConfiguredFieldCollectionSpeech(nextQuestion?.question, {
    fieldSchemas,
    activeToolAuthorized: Boolean(afterState.activeToolRequest?.authorizationRecordId),
  });
  if (!nextQuestionValidation.valid) {
    return Object.freeze({
      valid: false, reason: nextQuestionValidation.reason,
      field: nextQuestionValidation.field, state: afterState,
    });
  }
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
  const answer = effectiveDecision.responseId
    ? effectiveDecision.answer
    : composeConfiguredTurnResponse(effectiveDecision.answer, nextQuestion);
  if (answer) {
    memory.observeAssistantResponse?.(answer, { turnToken });
    memory.append?.({ role: 'assistant', content: answer }, { turnToken });
    afterState = memory.snapshot();
  }

  return Object.freeze({
    valid: true,
    decision: effectiveDecision.decision,
    answer,
    responseId: effectiveDecision.responseId,
    evidenceIds: effectiveDecision.evidenceIds,
    stateUpdate: effectiveDecision.stateUpdate,
    pendingQuestion: afterState.pendingQuestion,
    nextQuestion,
    toolRequest: awaitingConfirmation ? null : effectiveDecision.toolRequest,
    state: afterState,
  });
}
