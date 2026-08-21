import { validateGroundedLlmDecision } from './grounded-llm-decision.js';
import {
  configuredActionActivation,
  configuredToolAuthorization,
  evidenceBelongsToRuntime,
  validateDecisionSecurity,
} from './grounded-decision-security.js';
import {
  hydrateGroundingEnvelope,
  removeUnsupportedRecommendationSentences,
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

function callerFacingConversationMessage(source) {
  return String(source?.recordType ?? '').toLocaleUpperCase() === 'CONVERSATION_NODE'
    && source?.callerFacing === true
    && String(source?.authoritativeData?.nodeType ?? '').toLocaleLowerCase() === 'message';
}

const overviewRequestTypes = new Set([
  'overview', 'options', 'available_options', 'list_options', 'category_overview',
]);

const catalogFactRequestTypes = new Set([
  'details', 'item_details', 'price', 'inclusion', 'comparison', 'coverage',
  'preparation', 'attributes', 'services',
]);

function isOverviewDecision(decision) {
  return overviewRequestTypes.has(String(decision?.stateUpdate?.requestType
    ?? decision?.requestType ?? '').toLocaleLowerCase());
}

function hasCurrentActionEvidence(sources = []) {
  return sources.some((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'WORKFLOW_RULE'
    && source?.activationAllowed === true
    && String(source?.retrievalContext ?? 'primary').toLocaleLowerCase() === 'primary'
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

function catalogEntityFromEvidence(source, envelopeEntities = []) {
  if (String(source?.recordType ?? '').toLocaleUpperCase() !== 'CATALOG_ITEM') return null;
  const data = source.authoritativeData ?? {};
  const key = String(data.itemKey ?? '').trim();
  const name = String(data.name ?? '').trim();
  if (!key || !name) return null;
  return envelopeEntities.find((entity) => identity(entity?.key) === identity(key)) ?? {
    id: source.recordId ?? null,
    key,
    name,
    category: data.category ?? null,
    categoryKey: data.categoryKey ?? null,
  };
}

function primaryCatalogEntities(evidence = []) {
  return evidence
    .filter((source) => String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
      && String(source?.retrievalContext ?? 'primary').toLocaleLowerCase() === 'primary')
    .sort((left, right) => Number(left.rank ?? 0) - Number(right.rank ?? 0))
    .map((source) => catalogEntityFromEvidence(source, []))
    .filter(Boolean);
}

function exactPrimaryCatalogSource(envelope, evidence = []) {
  const exactRecordIds = [...new Set(evidence.filter((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && String(source?.retrievalContext ?? '').toLocaleLowerCase() === 'primary'
    && (source?.channels ?? []).includes('catalog_identity')
  )).map((source) => source.recordId).filter(Boolean))];
  // One exact identity is an item selection. Multiple identity rows represent
  // a category and must remain a caller/model choice instead of arbitrarily
  // forcing one child item.
  if (exactRecordIds.length !== 1) return null;
  return (envelope.sources ?? []).find((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && source.recordId === exactRecordIds[0]
  )) ?? null;
}

function rememberedCatalogSource(envelope, beforeState, evidence = []) {
  const currentSelection = beforeState.selectedCatalogItem ?? beforeState.selectedItem ?? null;
  const rememberedEntities = currentSelection ? [currentSelection] : (beforeState.knownEntities ?? []);
  const remembered = new Set(rememberedEntities.flatMap((entity) => [
    entity?.id, entity?.key, entity?.name,
  ]).map(identity).filter(Boolean));
  if (!remembered.size) return null;
  const matchesRemembered = (source) => {
    if (String(source?.recordType ?? '').toLocaleUpperCase() !== 'CATALOG_ITEM') return false;
    const data = source.authoritativeData ?? {};
    return [source.recordId, data.itemKey, data.name].map(identity)
      .filter(Boolean).some((value) => remembered.has(value));
  };
  const candidates = (envelope.sources ?? []).filter(matchesRemembered)
    .sort((left, right) => Number(left.rank ?? Number.MAX_SAFE_INTEGER)
      - Number(right.rank ?? Number.MAX_SAFE_INTEGER));
  if (!candidates.length) return null;
  // A different primary Catalog entity means the caller changed topic. In
  // that case memory must not add the previous item's citation.
  const differentPrimaryEntity = evidence.some((source) => (
    String(source?.retrievalContext ?? '').toLocaleLowerCase() === 'primary'
    && String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && !matchesRemembered(source)
  ));
  return differentPrimaryEntity ? null : candidates[0];
}

function memoryResolvedContext(decision, selectedEvidence, beforeState, envelopeEntities = []) {
  const remembered = new Set((beforeState.knownEntities ?? []).flatMap((entity) => [
    entity?.id, entity?.key, entity?.name,
  ]).map(identity).filter(Boolean));
  if (!remembered.size) return false;
  const memorySources = selectedEvidence.filter((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && String(source?.retrievalContext ?? '').toLocaleLowerCase() === 'contextual'
    && (source?.channels ?? []).includes('conversation_memory')
  ));
  const selectedMatchesMemory = memorySources.some((source) => {
    const entity = catalogEntityFromEvidence(source, envelopeEntities);
    return [entity?.id, entity?.key, entity?.name].map(identity)
      .filter(Boolean).some((value) => remembered.has(value));
  });
  if (!selectedMatchesMemory) return false;
  const proposedTopic = identity(decision?.stateUpdate?.currentTopic);
  // An explicitly different topic must never be reinterpreted as contextual.
  return !proposedTopic || remembered.has(proposedTopic);
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
  const beforeState = memory.snapshot();
  const hydratedEnvelope = hydrateGroundingEnvelope(groundingEnvelope, evidence);
  const rememberedSource = rememberedCatalogSource(hydratedEnvelope, beforeState, evidence);
  const requiredCatalogSource = exactPrimaryCatalogSource(hydratedEnvelope, evidence)
    ?? rememberedSource;
  const runtime = {
    fieldSchemas,
    toolSchemas: tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      identifiers: [...(tool.identifiers ?? [])],
      description: tool.description,
      inputSchema: tool.inputSchema ?? tool.configuration?.inputSchema
        ?? tool.configuration?.input_schema ?? { type: 'object', properties: {} },
    })),
    activeToolRequest: memory.snapshot().activeToolRequest,
    requiredEvidenceIds: requiredCatalogSource ? [requiredCatalogSource.id] : [],
  };
  const validatedDecision = validateGroundedLlmDecision(rawDecision, hydratedEnvelope, runtime);
  if (!validatedDecision.valid) {
    return Object.freeze({
      valid: false,
      reason: validatedDecision.reason,
      numbers: Object.freeze([...(validatedDecision.numbers ?? [])]),
      rejectedSentence: validatedDecision.rejectedAnswer ?? null,
      evidenceIds: Object.freeze([...(validatedDecision.evidenceIds ?? [])]),
      state: memory.snapshot(),
    });
  }

  const rememberedContextEntity = rememberedSource
    ? catalogEntityFromEvidence(rememberedSource, hydratedEnvelope.entities) : null;
  const rememberedRuntimeEvidence = rememberedSource ? evidence.find((source) => (
    source.id === rememberedSource.id
    || (rememberedSource.recordId && source.recordId === rememberedSource.recordId)
  )) : null;
  const retainRememberedCatalogCitation = validatedDecision.decision === 'answer'
    && !validatedDecision.responseId
    && rememberedSource
    && !(validatedDecision.evidenceIds ?? []).includes(rememberedSource.id);
  const retainRememberedCatalogContext = validatedDecision.decision === 'answer'
    && !validatedDecision.responseId
    && rememberedContextEntity
    && String(rememberedRuntimeEvidence?.retrievalContext ?? '').toLocaleLowerCase() === 'contextual'
    && (rememberedRuntimeEvidence?.channels ?? []).includes('conversation_memory');
  // The model chooses wording, while runtime owns conversation continuity and
  // traceability. A contextual follow-up must retain the canonical Catalog
  // entity even when the model already cited its source and also cited another
  // candidate. A genuinely different primary identity makes rememberedSource
  // null above, so an explicit topic change still replaces stale memory.
  const decision = retainRememberedCatalogCitation || retainRememberedCatalogContext
    ? Object.freeze({
    ...validatedDecision,
    evidenceIds: Object.freeze([...new Set([
      rememberedSource.id, ...(validatedDecision.evidenceIds ?? []),
    ])].slice(0, 5)),
    evidenceSourceIds: Object.freeze([...new Set([
      rememberedSource.id, ...(validatedDecision.evidenceSourceIds ?? []),
    ])].slice(0, 5)),
    stateUpdate: retainRememberedCatalogContext ? Object.freeze({
      ...validatedDecision.stateUpdate,
      currentTopic: rememberedContextEntity.key,
      knownEntityKeys: Object.freeze([...new Set([
        rememberedContextEntity.key,
        ...(validatedDecision.stateUpdate.knownEntityKeys ?? []),
      ])].slice(0, 5)),
      knownEntities: Object.freeze([
        rememberedContextEntity,
        ...(validatedDecision.stateUpdate.knownEntities ?? []).filter((entity) => (
          identity(entity?.key) !== identity(rememberedContextEntity.key)
        )),
      ].slice(0, 5)),
      contextDependent: true,
    }) : validatedDecision.stateUpdate,
  }) : validatedDecision;
  const initiallySelectedEvidence = selectedSources(decision, hydratedEnvelope, evidence);
  const citedCatalogEntities = new Map(initiallySelectedEvidence.map((source) => (
    catalogEntityFromEvidence(source, hydratedEnvelope.entities)
  )).filter(Boolean).map((entity) => [identity(entity.key), entity]));
  const exactCatalogIdentitySources = evidence.filter((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && String(source?.retrievalContext ?? '').toLocaleLowerCase() === 'primary'
    && (source?.channels ?? []).includes('catalog_identity')
  ));
  const exactCategoryKeys = new Set(exactCatalogIdentitySources.map((source) => (
    identity(source?.authoritativeData?.categoryKey ?? source?.authoritativeData?.category)
  )).filter(Boolean));
  const exactCategorySelection = exactCatalogIdentitySources.length > 1
    && exactCategoryKeys.size === 1 ? Object.freeze({
      key: exactCatalogIdentitySources[0].authoritativeData?.categoryKey ?? null,
      name: exactCatalogIdentitySources[0].authoritativeData?.category ?? null,
      parentKey: exactCatalogIdentitySources[0].authoritativeData?.parentCategoryKey ?? null,
      description: exactCatalogIdentitySources[0].authoritativeData?.categoryDescription ?? null,
      items: exactCatalogIdentitySources.map((source) => ({
        id: source.recordId,
        key: source.authoritativeData?.itemKey,
        name: source.authoritativeData?.name,
        categoryKey: source.authoritativeData?.categoryKey,
        parentCategoryKey: source.authoritativeData?.parentCategoryKey,
      })),
    }) : null;
  // A decision citing one authoritative Catalog item has resolved that item,
  // even if the model omitted optional state metadata. Persist the evidence-
  // derived canonical identity so contextual follow-ups cannot lose it.
  const evidenceResolvedEntity = !exactCategorySelection && citedCatalogEntities.size === 1
    ? [...citedCatalogEntities.values()][0] : null;
  const resolvedFromMemory = memoryResolvedContext(
    decision, initiallySelectedEvidence, beforeState, hydratedEnvelope.entities,
  );
  const decisionWithEvidenceState = evidenceResolvedEntity && decision.decision === 'answer'
    ? Object.freeze({
      ...decision,
      stateUpdate: Object.freeze({
        ...decision.stateUpdate,
        currentTopic: evidenceResolvedEntity.key,
        knownEntityKeys: Object.freeze([evidenceResolvedEntity.key]),
        knownEntities: Object.freeze([{ ...evidenceResolvedEntity }]),
        contextDependent: decision.stateUpdate.contextDependent === true || resolvedFromMemory,
      }),
    })
    : decision;
  // An exact response is selected only through responseId. Merely citing an
  // exact-message source alongside Catalog evidence does not make that message
  // the turn answer or complete the pending conversation question.
  const exactPublishedResponse = Boolean(decisionWithEvidenceState.responseId);
  const explicitLatestTopic = decisionWithEvidenceState.stateUpdate.contextDependent !== true
    && !beforeState.activeToolRequest
    && decisionWithEvidenceState.stateUpdate.knownEntities.length > 0;
  const independentLatestAnswer = decisionWithEvidenceState.decision === 'answer'
    && decisionWithEvidenceState.stateUpdate.contextDependent !== true
    && !beforeState.activeToolRequest;
  const pendingQuestionCompleted = decisionWithEvidenceState.stateUpdate.pendingQuestionRelevant === false;
  // An exact overview/message already contains its configured next question.
  // A specific new topic also completes any stale introduction/overview
  // prompt. Relevant guidance can still supply the next current question.
  let effectiveDecision = exactPublishedResponse || explicitLatestTopic
    || independentLatestAnswer || pendingQuestionCompleted
    ? Object.freeze({
      ...decisionWithEvidenceState,
      // Exact caller-facing responses already contain their configured
      // continuation. For ordinary answers retain the model's proposed
      // question only long enough for exact published-guidance validation;
      // it is never written directly to memory.
      pendingQuestion: exactPublishedResponse ? null : decisionWithEvidenceState.pendingQuestion,
      pendingQuestionRelevant: false,
      stateUpdate: Object.freeze({
        ...decisionWithEvidenceState.stateUpdate, pendingQuestionRelevant: false,
      }),
    })
    : decisionWithEvidenceState;
  if (exactCategorySelection) {
    effectiveDecision = Object.freeze({
      ...effectiveDecision,
      currentTopic: exactCategorySelection.key ?? exactCategorySelection.name,
      selectedEntityKeys: Object.freeze([]),
      selectedEntities: Object.freeze([]),
      requestType: 'category_overview',
      stateUpdate: Object.freeze({
        ...effectiveDecision.stateUpdate,
        currentTopic: exactCategorySelection.key ?? exactCategorySelection.name,
        knownEntityKeys: Object.freeze([]),
        knownEntities: Object.freeze([]),
        requestType: 'category_overview',
        contextDependent: false,
        pendingQuestionRelevant: false,
      }),
    });
  }
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
  // An explicit latest-turn Catalog match outranks saved conversational
  // context. A contextual record may answer a pronoun/follow-up only when
  // the primary query did not resolve a Catalog item. This prevents a prior
  // selection from making a new item request answer with the old item.
  const primaryEntities = primaryCatalogEntities(evidence);
  const selectedEntities = selectedEvidence.map((source) => catalogEntityFromEvidence(
    source, hydratedEnvelope.entities,
  )).filter(Boolean);
  if (primaryEntities.length > 0
    && effectiveDecision.stateUpdate.contextDependent !== true
    && !effectiveDecision.responseId) {
    const primaryKeys = new Set(primaryEntities.map((entity) => identity(entity.key)));
    if (!selectedEntities.some((entity) => primaryKeys.has(identity(entity.key)))) {
      return Object.freeze({
        valid: false, reason: 'latest_request_evidence_mismatch', state: beforeState,
      });
    }
  }
  const selectedCatalogContexts = selectedEvidence.filter((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
  )).map((source) => source.retrievalContext).filter(Boolean);
  if (selectedCatalogContexts.length > 0
    && effectiveDecision.stateUpdate.contextDependent !== true
    && !selectedCatalogContexts.includes('primary')) {
    return Object.freeze({
      valid: false, reason: 'latest_request_evidence_mismatch', state: beforeState,
    });
  }
  if (effectiveDecision.stateUpdate.knownEntities.some((entity) => (
    !entitySupportedBySelectedCatalog(entity, selectedEvidence)
  ))) {
    return Object.freeze({
      valid: false, reason: 'unsupported_selected_entity', state: beforeState,
    });
  }
  // Evidence ownership is an invariant at the final speech boundary. General
  // overview wording belongs to a caller-facing Conversation message; entity
  // facts belong to hydrated Catalog records. This is deliberately based on
  // document types and resolved state, never tenant/business vocabulary.
  const categoryOverviewDecision = String(effectiveDecision.stateUpdate.requestType
    ?? effectiveDecision.requestType ?? '').toLocaleLowerCase() === 'category_overview';
  if (effectiveDecision.decision === 'answer' && isOverviewDecision(effectiveDecision)
    && !categoryOverviewDecision
    && !selectedEvidence.some(callerFacingConversationMessage)) {
    return Object.freeze({
      valid: false, reason: 'overview_conversation_evidence_required', state: beforeState,
    });
  }
  const catalogFactAnswer = effectiveDecision.decision === 'answer'
    && !effectiveDecision.responseId
    && (selectedEntities.length > 0
      || effectiveDecision.stateUpdate.knownEntities.length > 0
      || primaryEntities.length > 0
      || catalogFactRequestTypes.has(String(effectiveDecision.stateUpdate.requestType
        ?? effectiveDecision.requestType ?? '').toLocaleLowerCase()));
  if (catalogFactAnswer && !selectedEvidence.some((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
  ))) {
    return Object.freeze({
      valid: false, reason: 'catalog_evidence_required', state: beforeState,
    });
  }
  // Workflow rules are internal authorization evidence and therefore are not
  // caller-citable. They must nevertheless come from the current primary
  // retrieval, never merely from saved or expanded context.
  const actionEvidence = sourcesByType(evidence, 'WORKFLOW_RULE').filter((source) => (
    String(source?.retrievalContext ?? 'primary').toLocaleLowerCase() === 'primary'
  ));
  const configuredActivation = !beforeState.activeToolRequest
    && !effectiveDecision.toolRequest
    && !effectiveDecision.stateUpdate.activeToolRequest
    ? configuredActionActivation({
      evidenceScope,
      toolSchemas: runtime.toolSchemas,
      actionEvidence,
    }) : null;
  if (configuredActivation?.valid) {
    effectiveDecision = Object.freeze({
      ...effectiveDecision,
      stateUpdate: Object.freeze({
        ...effectiveDecision.stateUpdate,
        activeToolRequest: Object.freeze({
          name: configuredActivation.tool.name,
          status: 'collecting_information',
        }),
      }),
      activeToolRequest: Object.freeze({
        name: configuredActivation.tool.name,
        status: 'collecting_information',
      }),
    });
  }
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
  const collectedInformationUpdate = Object.keys(
    effectiveDecision.stateUpdate.collectedInformation ?? {},
  ).length > 0;
  const startsToolCollection = Boolean(effectiveDecision.stateUpdate.activeToolRequest)
    && !beforeState.activeToolRequest;
  if ((collectedInformationUpdate || startsToolCollection)
    && (!proposedToolName || preliminaryAction?.valid !== true)) {
    return Object.freeze({
      valid: false,
      reason: proposedToolName ? 'unauthorized_tool_request' : 'unauthorized_information_collection',
      state: beforeState,
    });
  }
  if (startsToolCollection && !hasCurrentActionEvidence(actionEvidence)) {
    return Object.freeze({
      valid: false, reason: 'explicit_action_request_required', state: beforeState,
    });
  }
  const claimEvidence = catalogFactAnswer
    ? sourcesByType(selectedEvidence, 'CATALOG_ITEM')
    : selectedEvidence;
  const recommendationSanitization = removeUnsupportedRecommendationSentences(
    effectiveDecision.answer,
    claimEvidence,
    { knownEntities: hydratedEnvelope.entities, finalizedUtterance },
  );
  if (recommendationSanitization.removed.length > 0) {
    if (!recommendationSanitization.answer) {
      return Object.freeze({
        valid: false,
        reason: 'unsupported_recommendation',
        rejectedSentence: recommendationSanitization.removed[0],
        evidenceIds: Object.freeze([...(effectiveDecision.evidenceIds ?? [])]),
        state: memory.snapshot(),
      });
    }
    effectiveDecision = Object.freeze({
      ...effectiveDecision,
      answer: recommendationSanitization.answer,
    });
  }
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
    claimEvidence,
    { knownEntities: hydratedEnvelope.entities, finalizedUtterance },
  );
  if (!claimValidation.valid) {
    return Object.freeze({
      valid: false,
      reason: claimValidation.reason,
      identifiers: Object.freeze([...(claimValidation.identifiers ?? [])]),
      numbers: Object.freeze([...(claimValidation.numbers ?? [])]),
      rejectedSentence: claimValidation.sentence ?? null,
      evidenceIds: Object.freeze([...(effectiveDecision.evidenceIds ?? [])]),
      state: memory.snapshot(),
    });
  }

  const applied = memory.applyGroundedDecision(effectiveDecision, { turnToken });
  if (applied?.stale) {
    return Object.freeze({ valid: false, reason: 'stale_turn', state: applied.state });
  }
  let afterState = memory.snapshot();
  if (exactCategorySelection) {
    afterState = memory.applyKnowledge({
      catalogSelection: { category: exactCategorySelection },
    });
  }
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
  const requestedToolSchema = (runtime.toolSchemas ?? []).find((tool) => (
    identity(tool?.name) === identity(requestedToolName)
  ));
  const schemaRequiresConfirmation = requestedToolSchema?.inputSchema?.['x-requires-confirmation'] === true;
  const confirmationRequired = schemaRequiresConfirmation || (confirmationConfiguration?.enabled === true
    && requestedToolName
    && String(confirmationConfiguration.intent ?? '').normalize('NFKC').toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
      === String(requestedToolName).normalize('NFKC').toLocaleLowerCase()
        .replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, ''));
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
    guidanceEvidence: sourcesByType(evidence, 'CONVERSATION_NODE').filter((source) => (
      String(source?.retrievalContext ?? 'primary').toLocaleLowerCase() === 'primary'
    )),
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
  const durableNextQuestion = nextQuestion?.source !== 'grounded_clarification';
  if (nextQuestion && durableNextQuestion) {
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
