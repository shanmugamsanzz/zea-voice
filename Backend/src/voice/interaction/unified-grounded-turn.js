import { validateGroundedLlmDecision } from './grounded-llm-decision.js';
import {
  configuredToolAuthorization,
  validateEvidenceScope,
  validateDecisionSecurity,
} from './grounded-decision-security.js';
import {
  hydrateGroundingEnvelope,
  removeUnsupportedRecommendationSentences,
  validateCallerProvidedState,
  validateGroundedClaims,
} from './grounded-claim-validator.js';
import {
  advanceSchemaDrivenWorkflowState,
  composeConfiguredTurnResponse,
  resolveNextConfiguredQuestion,
  validateConfiguredFieldCollectionSpeech,
} from './next-question-policy.js';

function sourcesByType(sources = [], recordType) {
  const expected = String(recordType ?? '').toLocaleUpperCase();
  return sources.filter((source) => String(source?.recordType ?? '').toLocaleUpperCase() === expected);
}

function selectedSources(decision, groundingEnvelope, evidence) {
  void evidence;
  const selected = new Set((decision.evidenceIds ?? []).map(identity));
  // hydrateGroundingEnvelope has already replaced every compact prompt source
  // with its authoritative PostgreSQL record while preserving the short LLM
  // source ID. Validate claims against that exact hydrated object instead of
  // performing a second source lookup through a different path.
  return (groundingEnvelope.sources ?? []).filter((source) => (
    selected.has(identity(source.id))
  ));
}

function catalogSources(sources = []) {
  return sources.filter((source) => ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(
    String(source?.recordType ?? '').toLocaleUpperCase(),
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
  'preparation', 'attributes', 'services', 'category_overview',
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
    const recordType = String(source?.recordType ?? '').toLocaleUpperCase();
    if (!['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(recordType)) return false;
    const data = source.authoritativeData ?? {};
    const identities = recordType === 'CATALOG_CATEGORY'
      ? [source.recordId, data.categoryKey, data.category]
      : [source.recordId, data.itemKey, data.name];
    return identities.map(identity)
      .filter(Boolean).some((candidate) => requested.has(candidate));
  });
}

function catalogCategoryFromEvidence(source) {
  if (String(source?.recordType ?? '').toLocaleUpperCase() !== 'CATALOG_CATEGORY') return null;
  const data = source.authoritativeData ?? {};
  const key = String(data.categoryKey ?? '').trim();
  const name = String(data.category ?? '').trim();
  if (!key || !name) return null;
  return Object.freeze({
    id: source.recordId ?? null,
    key,
    name,
    parentKey: data.parentCategoryKey ?? null,
    description: data.categoryDescription ?? null,
    items: Object.freeze((data.children ?? []).map((child) => Object.freeze({
      id: child.recordId ?? null,
      key: child.itemKey ?? null,
      name: child.name ?? null,
      categoryKey: key,
    }))),
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
      && String(source?.retrievalContext ?? 'primary').toLocaleLowerCase() === 'primary'
      && ((source?.channels ?? []).includes('catalog_identity')
        || (source?.reservationReasons ?? []).some((reason) => (
          ['explicit_entity', 'explicit_comparison'].includes(String(reason))
        ))))
    .sort((left, right) => Number(left.rank ?? 0) - Number(right.rank ?? 0))
    .map((source) => catalogEntityFromEvidence(source, []))
    .filter(Boolean);
}

function rawEvidenceFor(source, evidence = []) {
  return evidence.find((candidate) => (
    candidate?.recordId && candidate.recordId === source?.recordId
  )) ?? null;
}

function explicitlySelectedCatalogEntities(selectedEvidence = [], evidence = [], envelopeEntities = []) {
  const entities = [];
  const seen = new Set();
  for (const source of selectedEvidence) {
    const entity = catalogEntityFromEvidence(source, envelopeEntities);
    if (!entity) continue;
    const raw = rawEvidenceFor(source, evidence);
    const reasons = new Set([
      ...(source?.reservationReasons ?? []), ...(raw?.reservationReasons ?? []),
    ].map(String));
    const explicit = String(raw?.retrievalContext ?? source?.retrievalContext ?? 'primary')
      .toLocaleLowerCase() === 'primary'
      && (((raw?.channels ?? source?.channels ?? []).includes('catalog_identity'))
        || reasons.has('explicit_entity') || reasons.has('explicit_comparison'));
    const key = identity(entity.key ?? entity.id ?? entity.name);
    if (!explicit || !key || seen.has(key)) continue;
    seen.add(key);
    entities.push(entity);
  }
  return entities;
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
    && (source?.channels ?? []).includes('catalog_identity')
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
 * The single post-LLM validation boundary for both spoken responses and tools.
 * Parsing/normalization has already selected one decision branch; this function
 * validates that branch against the same hydrated records and runtime schemas.
 */
export function validatePostLlmResponseAndTool({
  decision,
  selectedEvidence = [],
  evidenceScope = null,
  fieldSchemas = [],
  claimEvidence = [],
  envelopeEntities = [],
  finalizedUtterance = '',
  securityRuntime = {},
  approvedZeroEvidenceResponse = false,
} = {}) {
  const invalidScope = selectedEvidence.map((source) => (
    validateEvidenceScope(source, evidenceScope)
  )).find((validation) => !validation.valid);
  if (invalidScope) return Object.freeze({ valid: false, reason: invalidScope.reason });

  if ((decision?.stateUpdate?.knownEntities ?? []).some((entity) => (
    !entitySupportedBySelectedCatalog(entity, selectedEvidence)
  ))) return Object.freeze({ valid: false, reason: 'unsupported_selected_entity' });

  // The validator may be reused by tests and non-voice callers, so enforce
  // the selected-turn boundary here instead of trusting the supplied claim
  // array. No unselected hydrated record may authorize a generated claim.
  const selectedClaimIdentities = new Set(selectedEvidence.flatMap((source) => [
    source?.id, source?.recordId, source?.publishedEvidenceId,
  ]).map(identity).filter(Boolean));
  const exactClaimEvidence = claimEvidence.filter((source) => (
    [source?.id, source?.recordId, source?.publishedEvidenceId]
      .map(identity).filter(Boolean).some((value) => selectedClaimIdentities.has(value))
  ));
  const collectedInformation = {
    ...(securityRuntime.collectedInformation ?? {}),
    ...(decision?.fieldUpdates ?? {}),
    ...(decision?.stateUpdate?.collectedInformation ?? {}),
  };
  const callerProvidedFields = fieldSchemas.flatMap((field) => (
    Object.hasOwn(collectedInformation, field.key) ? [Object.freeze({
      key: field.key, label: field.label, question: field.question,
      value: collectedInformation[field.key],
    })] : []
  ));
  const claimOptions = Object.freeze({
    knownEntities: envelopeEntities,
    finalizedUtterance,
    callerProvidedFields: Object.freeze(callerProvidedFields),
  });

  const recommendation = approvedZeroEvidenceResponse
    ? Object.freeze({ answer: decision?.answer ?? '', removed: Object.freeze([]) })
    : removeUnsupportedRecommendationSentences(
      decision?.answer,
      exactClaimEvidence,
      claimOptions,
    );
  if (recommendation.removed.length > 0 && !recommendation.answer) {
    return Object.freeze({
      valid: false,
      reason: 'unsupported_recommendation',
      rejectedSentence: recommendation.removed[0],
    });
  }
  const normalizedDecision = recommendation.removed.length > 0
    ? Object.freeze({ ...decision, answer: recommendation.answer }) : decision;

  const fieldCollection = validateConfiguredFieldCollectionSpeech(
    [normalizedDecision?.answer, normalizedDecision?.pendingQuestion]
      .filter(Boolean).join(' '),
    {
      fieldSchemas,
      activeToolAuthorized: securityRuntime.activeToolAuthorized === true,
    },
  );
  if (!fieldCollection.valid) return Object.freeze({
    valid: false, reason: fieldCollection.reason, field: fieldCollection.field,
  });

  // CLARIFY is a question about missing or ambiguous meaning, not a factual
  // answer. It still passes evidence scope, configured-field and tool security
  // checks, but must not be rejected by factual claim validation.
  if (normalizedDecision?.decision === 'clarify') {
    const security = validateDecisionSecurity({
      sources: selectedEvidence,
      toolRequest: normalizedDecision.toolRequest,
      runtime: securityRuntime,
    });
    return Object.freeze({
      valid: security.valid === true,
      reason: security.reason ?? null,
      decision: normalizedDecision,
      security,
    });
  }

  const claims = approvedZeroEvidenceResponse
    ? Object.freeze({ valid: true })
    : validateGroundedClaims(
      normalizedDecision?.answer,
      exactClaimEvidence,
      claimOptions,
    );
  if (!claims.valid) return Object.freeze({
    valid: false,
    reason: claims.reason,
    identifiers: Object.freeze([...(claims.identifiers ?? [])]),
    numbers: Object.freeze([...(claims.numbers ?? [])]),
    rejectedSentence: claims.sentence ?? null,
  });

  const security = validateDecisionSecurity({
    sources: selectedEvidence,
    toolRequest: normalizedDecision?.toolRequest,
    runtime: securityRuntime,
  });
  return Object.freeze({
    valid: security.valid === true,
    reason: security.reason ?? null,
    decision: normalizedDecision,
    security,
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
  clarificationRecovery = null,
  clarificationContext = null,
  zeroEvidenceResponse = '',
  canonicalEntityAuthority = false,
} = {}) {
  if (!memory?.snapshot || !memory?.applyGroundedDecision || !memory?.restoreValidatedState) {
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
    clarificationContext,
    zeroEvidenceResponse,
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
  const selectedCategorySource = initiallySelectedEvidence.find((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_CATEGORY'
    && String(source?.retrievalContext ?? 'primary').toLocaleLowerCase() === 'primary'
  ));
  const exactCatalogIdentitySources = evidence.filter((source) => (
    String(source?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_ITEM'
    && String(source?.retrievalContext ?? '').toLocaleLowerCase() === 'primary'
    && (source?.channels ?? []).includes('catalog_identity')
  ));
  const exactCategoryKeys = new Set(exactCatalogIdentitySources.map((source) => (
    identity(source?.authoritativeData?.categoryKey ?? source?.authoritativeData?.category)
  )).filter(Boolean));
  const exactCategorySelection = catalogCategoryFromEvidence(selectedCategorySource)
    ?? (exactCatalogIdentitySources.length > 1
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
    }) : null);
  const resolvedFromMemory = memoryResolvedContext(
    decision, initiallySelectedEvidence, beforeState, hydratedEnvelope.entities,
  );
  const explicitMemoryEntities = exactCategorySelection ? []
    : explicitlySelectedCatalogEntities(
      initiallySelectedEvidence, evidence, hydratedEnvelope.entities,
    );
  const contextualMemoryEntity = resolvedFromMemory ? rememberedContextEntity : null;
  const memoryEntities = explicitMemoryEntities.length
    ? explicitMemoryEntities : (contextualMemoryEntity ? [contextualMemoryEntity] : []);
  const modelProposedEntities = decision.stateUpdate.knownEntities.length > 0;
  // Citations prove claims, not caller selection. Persist only entities tied
  // to explicit latest-turn identity/comparison reservations, or the exact
  // remembered record confirmed by contextual retrieval.
  const decisionWithEvidenceState = decision.decision !== 'clarify'
    ? Object.freeze({
      ...decision,
      stateUpdate: Object.freeze({
        ...decision.stateUpdate,
        currentTopic: memoryEntities.length
          ? memoryEntities.map((entity) => entity.key).join(' / ')
          : (modelProposedEntities ? beforeState.currentTopic : decision.stateUpdate.currentTopic),
        knownEntityKeys: Object.freeze(memoryEntities.map((entity) => entity.key)),
        knownEntities: Object.freeze(memoryEntities.map((entity) => ({ ...entity }))),
        contextDependent: contextualMemoryEntity ? true
          : (explicitMemoryEntities.length ? false : decision.stateUpdate.contextDependent),
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
  // An explicit latest-turn Catalog match outranks saved conversational
  // context. A contextual record may answer a pronoun/follow-up only when
  // the primary query did not resolve a Catalog item. This prevents a prior
  // selection from making a new item request answer with the old item.
  const primaryEntities = primaryCatalogEntities(evidence);
  const selectedEntities = selectedEvidence.map((source) => catalogEntityFromEvidence(
    source, hydratedEnvelope.entities,
  )).filter(Boolean);
  if (effectiveDecision.decision === 'answer'
    && primaryEntities.length > 0
    && !exactCategorySelection
    && effectiveDecision.stateUpdate.contextDependent !== true
    && !effectiveDecision.responseId) {
    const primaryKeys = new Set(primaryEntities.map((entity) => identity(entity.key)));
    if (!selectedEntities.some((entity) => primaryKeys.has(identity(entity.key)))) {
      return Object.freeze({
        valid: false, reason: 'latest_request_evidence_mismatch', state: beforeState,
      });
    }
  }
  const selectedCatalogContexts = catalogSources(selectedEvidence)
    .map((source) => source.retrievalContext).filter(Boolean);
  if (effectiveDecision.decision === 'answer'
    && selectedCatalogContexts.length > 0
    && effectiveDecision.stateUpdate.contextDependent !== true
    && !selectedCatalogContexts.includes('primary')) {
    return Object.freeze({
      valid: false, reason: 'latest_request_evidence_mismatch', state: beforeState,
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
  if (catalogFactAnswer && catalogSources(selectedEvidence).length === 0) {
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
  // Workflow retrieval supplies authorization, never intent. Only the
  // grounded decision may explicitly start the configured action lifecycle.
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
  const collectedInformationKeys = Object.keys(
    effectiveDecision.stateUpdate.collectedInformation ?? {},
  );
  const collectedInformationUpdate = collectedInformationKeys.length > 0;
  const configuredInformationFields = new Map((fieldSchemas ?? [])
    .map((field) => [field?.key, field]).filter(([key]) => Boolean(key)));
  const currentCallInformationOnly = collectedInformationUpdate
    && collectedInformationKeys.every((key) => {
      const field = configuredInformationFields.get(key);
      return field && !field.requiredAction;
    });
  const startsToolCollection = Boolean(effectiveDecision.stateUpdate.activeToolRequest)
    && !beforeState.activeToolRequest;
  if (((collectedInformationUpdate && !currentCallInformationOnly) || startsToolCollection)
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
  const claimEvidence = catalogFactAnswer ? catalogSources(selectedEvidence) : selectedEvidence;
  const preValidationToolName = effectiveDecision.toolRequest?.name
    ?? effectiveDecision.stateUpdate.activeToolRequest?.name
    ?? beforeState.activeToolRequest?.name;
  // Every external action uses a second-turn TOOL boundary after the caller
  // hears the collected values and explicitly confirms them.
  const confirmationRequired = Boolean(preValidationToolName);
  const postLlmValidation = validatePostLlmResponseAndTool({
    decision: effectiveDecision,
    selectedEvidence,
    evidenceScope,
    fieldSchemas,
    claimEvidence,
    envelopeEntities: hydratedEnvelope.entities,
    finalizedUtterance,
    securityRuntime: {
      answer: effectiveDecision.answer,
      evidenceScope,
      toolSchemas: runtime.toolSchemas,
      actionEvidence,
      catalogEvidence: sourcesByType(selectedEvidence, 'CATALOG_ITEM'),
      selectedEntities: exactSelectedEntities,
      activeToolRequest: beforeState.activeToolRequest?.authorizationRecordId
        ? beforeState.activeToolRequest : effectiveDecision.stateUpdate.activeToolRequest,
      knownEntities: effectiveDecision.stateUpdate.knownEntities,
      collectedInformation: {
        ...(beforeState.collectedInformation ?? {}),
        ...(effectiveDecision.stateUpdate.collectedInformation ?? {}),
      },
      configuredFieldKeys: fieldSchemas.map((field) => field.key),
      confirmationRequired,
      requireCurrentActionEvidence: effectiveDecision.toolRequest !== null
        && !beforeState.activeToolRequest?.authorizationRecordId,
      safetyPolicies,
      activeToolAuthorized: preliminaryAction?.valid === true,
    },
    approvedZeroEvidenceResponse: effectiveDecision.approvedZeroEvidenceResponse === true,
  });
  const awaitingConfirmation = postLlmValidation.reason === 'confirmation_required'
    && preliminaryAction?.valid === true;
  if (!postLlmValidation.valid && !awaitingConfirmation) {
    return Object.freeze({
      valid: false,
      reason: postLlmValidation.reason,
      identifiers: postLlmValidation.identifiers ?? Object.freeze([]),
      numbers: postLlmValidation.numbers ?? Object.freeze([]),
      rejectedSentence: postLlmValidation.rejectedSentence ?? null,
      evidenceIds: effectiveDecision.evidenceIds,
      toolRequest: null,
      state: beforeState,
    });
  }
  if (postLlmValidation.valid && postLlmValidation.decision !== effectiveDecision) {
    effectiveDecision = postLlmValidation.decision;
  }

  const applied = memory.applyGroundedDecision(effectiveDecision, {
    turnToken, canonicalEntityAuthority,
  });
  if (applied?.stale) {
    return Object.freeze({ valid: false, reason: 'stale_turn', state: applied.state });
  }
  const rollbackMemory = () => {
    const restored = memory.restoreValidatedState(beforeState, { turnToken });
    return restored?.state ?? memory.snapshot();
  };
  let afterState = memory.snapshot();
  if (exactCategorySelection && canonicalEntityAuthority !== true) {
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
      return Object.freeze({
        valid: false,
        reason: actionContext.reason === 'exact_selectable_catalog_item_required'
          ? actionContext.reason : 'unauthorized_tool_request',
        toolRequest: null,
        evidenceIds: effectiveDecision.evidenceIds, stateUpdate: effectiveDecision.stateUpdate,
        state: rollbackMemory(),
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
    if (actionContext.catalogItem && confirmationConfiguration?.catalogField) {
      afterState = memory.mergeCollectedData({
        [confirmationConfiguration.catalogField]: actionContext.catalogItem.name,
      });
    }
    const workflowTransition = advanceSchemaDrivenWorkflowState({
      activeRequest,
      fieldSchemas,
      collectedInformation: afterState.collectedInformation,
      tools,
      actionEvidence,
      confirmationConfiguration,
      confirmationAccepted: Boolean(effectiveDecision.toolRequest
        && beforeState.activeToolRequest?.status === 'awaiting_confirmation'),
    });
    if (!workflowTransition.valid) {
      return Object.freeze({
        valid: false, reason: workflowTransition.reason,
        toolRequest: null, state: rollbackMemory(),
      });
    }
    afterState = memory.setActiveToolRequest(
      workflowTransition.activeToolRequest, { turnToken },
    );
  }
  if (awaitingConfirmation) {
    // Same-turn fields and the Catalog selection remain committed, while the
    // external operation is suppressed until a later confirmed turn.
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
      field: nextQuestionValidation.field, state: rollbackMemory(),
    });
  }
  const groundedClarification = nextQuestion?.source === 'grounded_clarification';
  let effectiveNextQuestion = nextQuestion;
  let recovery = null;
  if (groundedClarification && memory.recordClarification) {
    const record = memory.recordClarification({
      key: effectiveDecision.clarification?.reason,
      question: nextQuestion.question,
      kind: 'clarification',
      reason: effectiveDecision.clarification?.reason,
      candidateRecordIds: (hydratedEnvelope.entities ?? [])
        .map((entity) => entity.recordId ?? entity.id).filter(Boolean).slice(0, 5),
      missingFactType: effectiveDecision.stateUpdate?.requestedFacts?.[0]
        ?? effectiveDecision.stateUpdate?.requestType ?? null,
    }, { turnToken });
    afterState = record.state ?? memory.snapshot();
    const maximumAttempts = Math.max(1, Math.min(5,
      Number.parseInt(clarificationRecovery?.maximumAttempts ?? 2, 10) || 2));
    if (record.repeated === true || record.attemptCount > maximumAttempts) {
      const configuredSupport = String(clarificationRecovery?.supportMessage ?? '').trim();
      // A genuine ambiguity must always leave the caller with audible speech.
      // If the tenant configured an escalation/support response, use it after
      // the allowed attempts. Otherwise retain the grounded LLM's targeted
      // question; an absent optional support message must never turn a valid
      // CLARIFY decision into silence or an inactivity prompt.
      if (configuredSupport) effectiveNextQuestion = null;
      recovery = Object.freeze({
        mode: configuredSupport ? 'configured_support' : 'grounded_clarification_retained',
        attemptCount: record.attemptCount,
        repeated: record.repeated === true,
      });
      if (configuredSupport) memory.clearClarification?.({ turnToken });
    }
  }
  const durableNextQuestion = effectiveNextQuestion
    && effectiveNextQuestion.source !== 'grounded_clarification';
  if (effectiveNextQuestion && durableNextQuestion) {
    afterState = memory.setPendingQuestion({
      key: effectiveNextQuestion.key,
      text: effectiveNextQuestion.question,
      kind: effectiveNextQuestion.kind,
    });
    if (effectiveNextQuestion.activeToolRequest) {
      afterState = memory.setActiveToolRequest(effectiveNextQuestion.activeToolRequest, { turnToken });
    }
  }
  const answer = recovery?.mode === 'configured_support'
    ? String(clarificationRecovery.supportMessage).trim()
    : (effectiveDecision.responseId
      ? effectiveDecision.answer
      : composeConfiguredTurnResponse(effectiveDecision.answer, effectiveNextQuestion));
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
    nextQuestion: effectiveNextQuestion,
    clarificationRecovery: recovery,
    toolRequest: awaitingConfirmation ? null : effectiveDecision.toolRequest,
    state: afterState,
  });
}
