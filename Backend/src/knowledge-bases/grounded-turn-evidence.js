import {
  rankAndHydrateAuthoritativeEvidence,
} from '../knowledge-engine/authoritative-evidence.js';
import { searchParallelHybridCandidates } from './parallel-hybrid-search.js';
import {
  normalizeCanonicalRecordMemory,
  resolveCanonicalTopicMemory,
} from '../knowledge-engine/canonical-topic-memory.js';
import {
  canonicalRecordIdentityKey,
} from '../knowledge-engine/canonical-record-identity.js';
import {
  buildDeterministicSourceMap,
  resolveDeterministicSource,
} from '../knowledge-engine/deterministic-source-mapping.js';
import { AppError } from '../middleware/errors.js';
import { resolveKnowledgeConfidenceConfiguration } from './knowledge-confidence-config.js';
import {
  isMandatoryCanonicalReservation,
} from '../knowledge-engine/canonical-retrieval-reservations.js';
import { selectCompleteConversationTurns } from '../knowledge-engine/conversation-turn-context.js';
import { resolveLiveMemoryConfiguration } from '../voice/interaction/live-memory-config.js';
import {
  createCanonicalGroundedEvidence,
} from '../knowledge-engine/grounded-evidence-representation.js';
import { env } from '../config/env.js';

export const GROUNDED_TURN_EVIDENCE_VERSION = 13;
const maximumEvidenceRecords = 5;

function directRememberedFollowupRetrieval(input = {}, classification = {}, resolution = {}) {
  const understanding = input.queryUnderstanding ?? {};
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const explicitCount = (understanding.explicitEntities?.length ?? 0)
    + (understanding.explicitCategories?.length ?? 0)
    + (understanding.comparisonEntities?.length ?? 0);
  const actionRequested = understanding.actionIntent?.detected === true
    || understanding.actionIntent?.requested === true
    || Boolean(memory.activeTool)
    || String(understanding.currentRouteSignal?.recordType ?? '').toUpperCase()
      === 'WORKFLOW_RULE'
    || String(classification.intentClass ?? '').toUpperCase() === 'ACTION_TOOL_REQUEST';
  const ambiguous = understanding.ambiguity?.detected === true
    || classification.requiresConfirmation === true
    || resolution.action === 'CONFIRM';
  const contextual = understanding.contextDependent === true
    || resolution.contextDependent === true;
  if (!contextual || explicitCount > 0 || actionRequested || ambiguous
    || String(classification.intentClass ?? '').toUpperCase() === 'COMPARISON_COMPLEX') return null;

  const scope = { tenantId: input.tenantId, agentId: input.agentId, callId: input.callId };
  const remembered = normalizeCanonicalRecordMemory(
    memory.activeEntity,
    { scope, expectedRecordType: 'CATALOG_ITEM' },
  );
  if (!remembered) return null;

  const reservation = Object.freeze({
    tenantId: remembered.tenantId,
    agentId: remembered.agentId ?? input.agentId,
    knowledgeBaseId: remembered.knowledgeBaseId,
    publicationRevision: remembered.publicationRevision,
    recordType: remembered.recordType,
    recordId: remembered.recordId,
    itemKey: remembered.itemKey,
    categoryKey: remembered.categoryKey ?? null,
    canonicalName: remembered.canonicalName,
    reason: 'canonical_memory',
  });
  const candidate = Object.freeze({
    ...reservation,
    namespace: 'CATALOG',
    channel: 'structured',
    rank: 1,
    namespaceRank: 1,
    score: 1,
    tokenCoverage: 1,
    callerFacingHint: true,
    authorizationHint: false,
    matchMethod: 'canonical_memory',
  });
  return Object.freeze({
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    intentClass: classification.intentClass ?? 'KNOWN_INFORMATION',
    retrievalMode: 'direct_canonical_memory',
    directCanonicalMemory: true,
    searchedIndexes: Object.freeze(['direct_canonical_memory']),
    relevantNamespaces: Object.freeze(['CATALOG']),
    primaryNamespaces: Object.freeze(['CATALOG']),
    recordTypes: Object.freeze(['CATALOG_ITEM']),
    queryContext: Object.freeze({
      contextDependent: true,
      contextualText: [remembered.canonicalName, input.requestedFact]
        .filter(Boolean).join(' '),
      reservedRecords: Object.freeze([reservation]),
    }),
    channels: Object.freeze({
      structured: Object.freeze([candidate]),
      bm25: Object.freeze([]),
      qdrant: Object.freeze([]),
    }),
    channelFailures: Object.freeze([]),
    candidateCount: 1,
  });
}

async function completeStageWithin(stage, operation, timeoutMs) {
  const deadlineMs = Math.max(1, Number(timeoutMs));
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError(
      504,
      `Knowledge ${stage} exceeded its production completion deadline`,
      stage === 'retrieval' ? 'KNOWLEDGE_RETRIEVAL_TIMEOUT' : 'KNOWLEDGE_HYDRATION_TIMEOUT',
      { stage: `authoritative_${stage}`, timeoutMs: deadlineMs, operationalFailure: true },
    )), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizedId(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function missingProvenanceFields(source, input) {
  const missing = [];
  for (const field of [
    'tenantId', 'agentId', 'knowledgeBaseId', 'publicationRevision',
    'recordId', 'recordType', 'documentId', 'documentVersionId',
  ]) {
    const value = source?.[field];
    if (value === null || value === undefined || String(value).trim() === '') missing.push(field);
  }
  if (!Number.isInteger(Number(source?.publicationRevision))
    || Number(source.publicationRevision) < 1) missing.push('publicationRevision');
  if (normalizedId(source?.tenantId) !== normalizedId(input?.tenantId)) missing.push('tenantScope');
  if (normalizedId(source?.agentId) !== normalizedId(input?.agentId)) missing.push('agentScope');
  if (source?.hydrationValidated !== true) missing.push('hydrationValidated');
  if (source?.publicationValidated !== true) missing.push('publicationValidated');
  if (String(source?.documentStatus ?? '').toLocaleLowerCase() !== 'ready') {
    missing.push('documentStatus');
  }
  if (String(source?.documentVersionStatus ?? '').toLocaleLowerCase() !== 'ready') {
    missing.push('documentVersionStatus');
  }
  if (source?.documentVersionIsCurrent !== true) missing.push('documentVersionIsCurrent');
  const provenance = source?.provenance ?? {};
  for (const field of [
    'tenantId', 'agentId', 'knowledgeBaseId', 'publicationRevision',
    'recordId', 'recordType', 'documentId', 'documentVersionId',
  ]) {
    if (normalizedId(provenance[field]) !== normalizedId(source?.[field])) {
      missing.push(`provenance.${field}`);
    }
  }
  return [...new Set(missing)];
}

export function assertCompleteAuthoritativeHydration(authoritative, input, classification = {}) {
  if (Number(authoritative?.hydrationQueryCount ?? 0) > 1) {
    throw new AppError(503, 'Authoritative evidence used more than one PostgreSQL hydration query',
      'KNOWLEDGE_AUTHORITATIVE_HYDRATION_QUERY_INVALID', {
        stage: 'authoritative_hydration',
        hydrationQueryCount: authoritative.hydrationQueryCount,
      });
  }
  const incomplete = (authoritative?.evidence ?? []).map((source) => ({
    source,
    missingFields: missingProvenanceFields(source, input),
  })).filter((entry) => entry.missingFields.length > 0);
  const comparisonTurn = String(classification?.intentClass ?? '').toLocaleUpperCase()
    === 'COMPARISON_COMPLEX';
  const missingComparisonIds = comparisonTurn
    ? authoritative?.comparisonCoverage?.missingRecordIds ?? [] : [];
  if (!incomplete.length && !missingComparisonIds.length) return;
  throw new AppError(503,
    'Authoritative PostgreSQL evidence is incomplete for the selected publication records',
    'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE', {
      stage: 'authoritative_hydration',
      records: incomplete.map(({ source, missingFields }) => ({
        recordId: source.recordId,
        recordType: source.recordType,
        knowledgeBaseId: source.knowledgeBaseId,
        publicationRevision: source.publicationRevision,
        missingFields,
      })),
      missingComparisonRecordIds: [...missingComparisonIds],
    });
}

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return clean(value, 240).toLocaleLowerCase();
}

function reservationKey(value) {
  const recordId = identity(value?.recordId ?? value?.id);
  const inferredRecordType = value?.recordType
    ?? (String(value?.entityType ?? '').toUpperCase() === 'CATEGORY'
      ? 'CATALOG_CATEGORY'
      : (String(value?.entityType ?? '').toUpperCase() === 'ITEM' ? 'CATALOG_ITEM' : ''));
  const recordType = clean(inferredRecordType, 80).toUpperCase();
  return recordId && recordType ? `${recordType}:${recordId}` : null;
}

function canonicalEvidenceKey(value, input = {}) {
  const canonical = canonicalRecordIdentityKey(value, {
    tenantId: value?.tenantId ?? input?.tenantId,
    knowledgeBaseId: value?.knowledgeBaseId,
    publicationRevision: value?.publicationRevision,
  });
  if (canonical) return canonical;
  const typedKey = reservationKey(value);
  const tenantId = normalizedId(value?.tenantId ?? input?.tenantId);
  return typedKey ? `${tenantId || 'tenant-unavailable'}:unscoped:${typedKey}` : null;
}

function matchingCanonicalEvidenceKeys(candidate, sources, input = {}) {
  const typedKey = reservationKey(candidate);
  if (!typedKey) return [];
  const scopedKey = canonicalEvidenceKey(candidate, input);
  const matches = sources.filter((source) => (
    reservationKey(source) === typedKey
    && normalizedId(source.tenantId) === normalizedId(input.tenantId)
    && (!candidate?.knowledgeBaseId
      || normalizedId(source.knowledgeBaseId) === normalizedId(candidate.knowledgeBaseId))
    && (!candidate?.publicationRevision
      || Number(source.publicationRevision) === Number(candidate.publicationRevision))
  )).map((source) => canonicalEvidenceKey(source, input)).filter(Boolean);
  if (scopedKey && matches.includes(scopedKey)) return [scopedKey];
  return [...new Set(matches)];
}

function requiredReservations(authoritative = {}) {
  return (authoritative.reservations ?? []).filter(isMandatoryCanonicalReservation);
}

function assertRequiredEvidenceInvariant(authoritative, hydratedRecords = null) {
  const required = requiredReservations(authoritative);
  if (!required.length) return;
  const evidence = hydratedRecords ?? authoritative?.evidence ?? [];
  const inputScope = {
    tenantId: authoritative?.tenantId,
    agentId: authoritative?.agentId,
    callId: authoritative?.callId,
  };
  const missing = required.filter((entry) => (
    matchingCanonicalEvidenceKeys(entry, evidence, inputScope).length === 0
  ));
  if (!missing.length) return;
  const rememberedMissing = missing.some((entry) => entry.reason === 'canonical_memory');
  throw new AppError(503, rememberedMissing
    ? 'The canonical call-memory record could not be hydrated from the active PostgreSQL publication'
    : 'A required current-request record disappeared from grounded evidence',
  rememberedMissing ? 'KNOWLEDGE_CONTEXT_RECORD_NOT_HYDRATED'
    : 'KNOWLEDGE_REQUIRED_EVIDENCE_NOT_PACKAGED', {
    stage: hydratedRecords ? 'grounded_evidence_packaging' : 'authoritative_hydration',
    missingRecords: missing.map((entry) => ({
      recordId: entry.recordId, recordType: entry.recordType, reason: entry.reason,
    })),
  });
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactValue(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return clean(value, 1_200);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 30)
    .map((entry) => compactValue(entry, depth + 1)));
  if (typeof value !== 'object') return null;
  return Object.freeze(Object.fromEntries(Object.entries(value).slice(0, 50)
    .map(([key, entry]) => [clean(key, 100), compactValue(entry, depth + 1)])));
}

function compactCanonicalMemory(input = {}, canonicalResolution = {}) {
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const understanding = input.queryUnderstanding ?? {};
  const hasCurrentEntityMention = (understanding.currentEntityCandidates?.length ?? 0) > 0
    || (understanding.explicitEntities?.length ?? 0) > 0
    || (understanding.explicitCategories?.length ?? 0) > 0;
  return Object.freeze({
    activeEntity: canonicalResolution.activeEntity ?? null,
    activeCategory: canonicalResolution.activeCategory ?? null,
    comparisonEntities: Object.freeze([...(canonicalResolution.comparisonEntities ?? [])]
      .slice(0, maximumEvidenceRecords)),
    pendingClarification: hasCurrentEntityMention
      ? null : compactValue(memory.pendingClarification),
    activeTool: compactValue(memory.activeTool),
    collectedToolFields: Object.freeze({ ...(memory.collectedToolFields ?? {}) }),
    pendingQuestion: compactValue(memory.pendingQuestion),
    latestCallerQuestion: clean(memory.latestCallerQuestion, 2_000) || null,
    requestedFacts: Object.freeze([...(understanding.requestedFacts
      ?? memory.requestedFacts ?? [])].slice(0, 20)),
    contextualReferences: Object.freeze([...(understanding.contextualReferences
      ?? memory.contextualReferences ?? [])].slice(0, 20)),
    correctedFields: Object.freeze([...(memory.correctedFields ?? [])].slice(0, 30)),
  });
}

function compactRelevantTurns(input = {}) {
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const understanding = input.queryUnderstanding ?? {};
  const currentEntityTerms = (understanding.currentEntityCandidates ?? [])
    .flatMap((candidate) => [candidate?.name, candidate?.canonicalName]).filter(Boolean);
  const pending = memory.pendingQuestion ?? memory.pendingClarification ?? {};
  const activeTool = memory.activeTool ?? memory.activeToolRequest ?? {};
  const collected = memory.collectedInformation ?? memory.collectedToolFields ?? {};
  const continuityTerms = [
    ...currentEntityTerms,
    memory.activeEntity?.name, memory.activeEntity?.key,
    memory.activeCategory?.name, memory.activeCategory?.key,
    pending?.key, pending?.text, pending?.kind,
    activeTool?.name, activeTool?.status,
    activeTool?.selectedEntityKey, activeTool?.selectedEntityName,
    ...(understanding.requestedFacts ?? memory.requestedFacts ?? []),
    ...Object.entries(collected).flatMap(([key, value]) => [key, value]),
  ].filter(Boolean);
  return Object.freeze(selectCompleteConversationTurns(input.recentRelevantTurns
    ?? memory.recentConversation ?? memory.recentTurns ?? [], {
    mode: memory.conversationContextMode,
    recentTurns: memory.conversationContextTurns,
    currentQuestion: input.currentQuestion ?? input.latestQuestion ?? input.utterance,
    contextTerms: continuityTerms,
  })
    .map((turn) => Object.freeze({
      role: turn?.role === 'assistant' ? 'assistant' : 'user',
      content: clean(turn?.content, 500),
    })).filter((turn) => turn.content));
}

function canonicalCandidateName(candidate = {}, evidenceByRecordId = new Map()) {
  const source = evidenceByRecordId.get(normalizedId(candidate.recordId));
  const data = source?.authoritativeData ?? {};
  if (String(candidate.recordType ?? '').toUpperCase() === 'CATALOG_CATEGORY') {
    return clean(data.category ?? candidate.name ?? candidate.label, 240);
  }
  if (String(candidate.recordType ?? '').toUpperCase() === 'CATALOG_ITEM') {
    return clean(data.name ?? candidate.name ?? candidate.label, 240);
  }
  return clean(candidate.name ?? candidate.label ?? data.question ?? data.name, 240);
}

function activeCategoryChildren(input = {}, authoritative = {}, resolvedCategory = null) {
  const memory = input?.canonicalCallMemory ?? input?.memory ?? {};
  if (!resolvedCategory && (memory.activeEntity || !memory.activeCategory)) return Object.freeze([]);
  const active = resolvedCategory ?? memory.activeCategory;
  const activeRecordId = normalizedId(active.recordId ?? active.id);
  const activeCategoryKey = normalizedId(active.categoryKey ?? active.key);
  const activeKnowledgeBaseId = normalizedId(active.knowledgeBaseId);
  const activeRevision = Number(active.publicationRevision);
  const category = (authoritative?.evidence ?? []).find((source) => {
    if (String(source?.recordType ?? '').toUpperCase() !== 'CATALOG_CATEGORY') return false;
    if (activeKnowledgeBaseId
      && normalizedId(source.knowledgeBaseId) !== activeKnowledgeBaseId) return false;
    if (Number.isInteger(activeRevision)
      && Number(source.publicationRevision) !== activeRevision) return false;
    return (activeRecordId && normalizedId(source.recordId) === activeRecordId)
      || (activeCategoryKey
        && normalizedId(source.authoritativeData?.categoryKey) === activeCategoryKey);
  });
  if (!category) return Object.freeze([]);
  return Object.freeze((category.authoritativeData?.children ?? []).filter((child) => (
    child && typeof child === 'object' && child.selectionRules?.selectable === true
  )).map((child) => Object.freeze({
    recordId: clean(child.recordId, 160) || null,
    recordType: 'CATALOG_ITEM',
    name: clean(child.name, 240) || null,
    itemKey: clean(child.itemKey, 160) || null,
    categoryKey: clean(category.authoritativeData?.categoryKey, 160) || null,
    knowledgeBaseId: category.knowledgeBaseId,
    publicationRevision: category.publicationRevision,
  })).filter((child) => child.recordId && child.name));
}

function categorySelectionContext(input = {}, classification = {}, children = []) {
  const understanding = input?.queryUnderstanding ?? {};
  const noCurrentItem = (understanding.explicitEntities?.length ?? 0) === 0;
  const explicitCategory = (understanding.explicitCategories?.length ?? 0) === 1;
  const contextual = understanding.contextDependent === true;
  const overview = String(classification?.intentClass ?? '').toUpperCase()
    === 'CATEGORY_OVERVIEW';
  const requestedFact = Boolean(clean(
    understanding.requestedFact ?? understanding.requestedFacts?.[0], 160,
  ));
  const actionRequested = understanding.actionIntent?.detected === true
    || understanding.actionIntent?.requested === true;
  const comparisonRequested = understanding.meaning?.comparisonRequested === true
    || (understanding.comparisonEntities?.length ?? 0) > 0;
  const requiresSelection = noCurrentItem && !overview
    && (explicitCategory || (contextual
      && (requestedFact || actionRequested || comparisonRequested)));
  return Object.freeze({
    detected: requiresSelection && children.length > 1,
    uniqueChild: requiresSelection && children.length === 1 ? children[0] : null,
  });
}

function ambiguityCandidates(
  input = {}, authoritative = {}, resolution = {}, classification = {}, categoryChildren = [],
) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    classification?.confidenceConfiguration ?? resolution?.confidenceConfiguration,
  );
  const evidenceByRecordId = new Map((authoritative?.evidence ?? []).map((source) => (
    [normalizedId(source.recordId), source]
  )));
  const mediumCandidates = (resolution?.routingCandidates ?? []).filter((candidate) => (
    evidenceByRecordId.has(normalizedId(candidate?.recordId))
    &&
    Number(candidate?.score ?? 0) >= confidenceConfiguration.clarificationConfidence
    && Number(candidate?.score ?? 0) < confidenceConfiguration.highConfidence
  ));
  const candidates = [
    ...(authoritative?.ambiguity?.candidates ?? []),
    ...(input?.queryUnderstanding?.ambiguity?.candidates ?? []),
    ...mediumCandidates,
    ...categoryChildren,
  ];
  const seen = new Set();
  return Object.freeze(candidates.flatMap((candidate) => {
    const recordId = clean(candidate?.recordId ?? candidate?.id, 160);
    const name = canonicalCandidateName(candidate, evidenceByRecordId);
    const recordType = clean(candidate?.recordType, 80).toUpperCase() || null;
    const key = `${recordType ?? ''}:${recordId || name.toLocaleLowerCase()}`;
    if ((!recordId && !name) || seen.has(key)) return [];
    seen.add(key);
    return [Object.freeze({
      recordId: recordId || null,
      recordType,
      name: name || null,
      score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
      confidenceBand: mediumCandidates.includes(candidate) ? 'MEDIUM' : null,
    })];
  }).slice(0, maximumEvidenceRecords));
}

function toolIdentifiers(tool = {}) {
  const configuration = object(tool.configuration);
  return new Set([
    tool.id, tool.name, configuration.identifier, configuration.toolIdentifier,
    configuration.actionKey, configuration.key,
  ].map(identity).filter(Boolean));
}

function workflowToolIdentifier(source = {}) {
  const action = object(source.authoritativeData?.actionConfig);
  return identity(action.toolIdentifier ?? action.actionKey ?? action.tool ?? action.action);
}

function applicableTools(evidence, runtimeProfile = {}) {
  const assigned = runtimeProfile.tools ?? [];
  const results = [];
  for (const workflow of evidence.filter((source) => (
    source.recordType === 'WORKFLOW_RULE'
    && source.hydrationValidated === true
    && identity(source.authoritativeData?.actionType) === 'configured_tool'
  ))) {
    const identifier = workflowToolIdentifier(workflow);
    if (!identifier) continue;
    for (const tool of assigned) {
      if (!toolIdentifiers(tool).has(identifier)) continue;
      const configuration = object(tool.configuration);
      const inputSchema = object(tool.inputSchema ?? configuration.inputSchema
        ?? configuration.input_schema ?? configuration.parametersSchema
        ?? configuration.parameters_schema);
      results.push(Object.freeze({
        workflowEvidenceId: workflow.id,
        workflowRecordId: workflow.recordId,
        toolId: clean(tool.id, 160) || null,
        toolName: clean(tool.name, 160),
        conditions: compactValue(workflow.authoritativeData?.conditions ?? {}),
        actionConfig: compactValue(workflow.authoritativeData?.actionConfig ?? {}),
        inputSchema: compactValue(inputSchema),
      }));
    }
  }
  return Object.freeze(results.slice(0, 3));
}

function selectHydratedRecordsForCurrentTurn(
  allHydrated = [], input = {}, authoritative = {}, classification = {}, resolution = {},
) {
  const understanding = input?.queryUnderstanding ?? {};
  const mandatory = requiredReservations(authoritative);
  const requiredKeys = new Set(mandatory
    .map((entry) => reservationKey(entry)).filter(Boolean));
  const memory = input?.canonicalCallMemory ?? input?.memory ?? {};
  const currentRecordIds = new Set([
    ...(understanding.currentEntityCandidates ?? []),
    ...(understanding.explicitEntities ?? []),
    ...(understanding.explicitCategories ?? []),
    ...(understanding.comparisonEntities ?? []),
  ].map((entry) => normalizedId(entry?.recordId ?? entry?.id)).filter(Boolean));
  if (resolution?.candidate?.explicit === true) {
    currentRecordIds.add(normalizedId(resolution.candidate.recordId));
  }
  const permittedKeys = new Set(requiredKeys);
  for (const candidate of [
    ...(understanding.explicitEntities ?? []),
    ...(understanding.explicitCategories ?? []),
    ...(understanding.comparisonEntities ?? []),
    ...(String(understanding.currentRouteSignal?.recordType ?? '').toUpperCase()
      === 'WORKFLOW_RULE' ? [understanding.currentRouteSignal] : []),
    ...(resolution?.candidate?.explicit === true ? [{
      ...resolution.candidate,
      recordType: resolution.candidate.recordType
        ?? (String(resolution.candidateNamespace ?? '').toUpperCase() === 'CATALOG'
          ? (String(resolution.candidate.entityType ?? '').toUpperCase() === 'CATEGORY'
            ? 'CATALOG_CATEGORY' : 'CATALOG_ITEM') : null),
    }] : []),
  ]) {
    const key = reservationKey(candidate);
    if (key) permittedKeys.add(key);
  }
  const staleMemoryIds = new Set([memory.activeEntity, memory.activeCategory]
    .map((entry) => normalizedId(entry?.recordId ?? entry?.id)).filter(Boolean));
  const focusedTurn = permittedKeys.size > 0 || mandatory.some((entry) => [
    'explicit_current_entity', 'explicit_entity', 'explicit_comparison',
    'canonical_memory', 'category_unique_child', 'applicable_workflow',
    'authorized_workflow',
  ].includes(String(entry.reason ?? '').toLocaleLowerCase()));
  const currentRouteId = normalizedId(understanding?.currentRouteSignal?.recordId);
  const overviewTurn = String(classification?.intentClass ?? '').toUpperCase()
    === 'CATEGORY_OVERVIEW';

  return allHydrated.filter((source) => {
    const key = reservationKey(source);
    if (permittedKeys.has(key)) return true;
    // Once the turn has an explicit entity, contextual entity, comparison, or
    // authorized action, no ordinary retrieval result may dilute that bounded
    // grounding set. Relevant facts must come from those hydrated records.
    if (focusedTurn) return false;
    const recordType = String(source?.recordType ?? '').toUpperCase();
    if (recordType === 'WORKFLOW_RULE') return false;
    if (recordType === 'CONVERSATION_NODE') {
      return Boolean(currentRouteId)
        && normalizedId(source.recordId) === currentRouteId;
    }
    if (recordType === 'CATALOG_CATEGORY' && !overviewTurn) return false;
    const recordId = normalizedId(source?.recordId);
    if (staleMemoryIds.has(recordId) && !currentRecordIds.has(recordId)) return false;
    return true;
  });
}

export function buildGroundedLlmInput({
  input, classification, resolution, authoritative, runtimeProfile,
} = {}) {
  const allHydrated = authoritative?.verifiedRecords ?? authoritative?.evidence ?? [];
  const hydrated = selectHydratedRecordsForCurrentTurn(
    allHydrated, input, authoritative, classification, resolution,
  );
  assertRequiredEvidenceInvariant(authoritative, hydrated);
  if (hydrated.length > maximumEvidenceRecords) {
    throw new TypeError('Grounded LLM input cannot contain more than five hydrated records');
  }
  const mandatoryReservations = requiredReservations(authoritative);
  const reservationReasons = (source) => mandatoryReservations.filter((reservation) => (
    reservationKey(reservation) === reservationKey(source)
    && normalizedId(reservation.tenantId ?? input.tenantId)
      === normalizedId(source.tenantId ?? input.tenantId)
    && (!reservation.knowledgeBaseId
      || normalizedId(reservation.knowledgeBaseId) === normalizedId(source.knowledgeBaseId))
    && (!reservation.publicationRevision
      || Number(reservation.publicationRevision) === Number(source.publicationRevision))
  )).map((reservation) => reservation.reason);
  let callerSourceIndex = 0;
  const hydratedRecords = Object.freeze(hydrated.map((source) => {
    const reasons = [...new Set([
      ...(source.reservationReasons ?? []).filter((reason) => (
        requiredReservations({ reservations: [{ reason }] }).length > 0
      )),
      ...reservationReasons(source),
    ])];
    return createCanonicalGroundedEvidence(source, source.callerFacing === true
      ? `source_${callerSourceIndex += 1}` : null, {
      requestedFact: input?.queryUnderstanding?.requestedFact ?? input?.requestedFact,
      requestedFacts: input?.queryUnderstanding?.requestedFacts ?? input?.requestedFacts,
      intentClass: classification?.intentClass,
      need: input?.queryUnderstanding?.need,
      required: reasons.length > 0,
      reservationReasons: reasons,
    });
  }));
  const sourceMap = buildDeterministicSourceMap(hydratedRecords.filter((source) => source.sourceId));
  const publicationRevisions = [...new Map(hydratedRecords.map((source) => [
    normalizedId(source.knowledgeBaseId),
    Object.freeze({
      knowledgeBaseId: source.knowledgeBaseId,
      publicationRevision: source.publicationRevision,
    }),
  ])).values()];
  // Production hydration exposes verifiedRecords. Resolve every source map
  // entry against that exact immutable set before it can reach the LLM.
  // The evidence fallback remains available only to isolated unit fixtures.
  if (Array.isArray(authoritative?.verifiedRecords)) {
    for (const mapping of sourceMap) {
      const resolved = resolveDeterministicSource(mapping, hydratedRecords, {
        tenantId: input.tenantId,
        agentId: input.agentId,
        publicationRevisions,
      });
      if (resolved.valid !== true) {
        throw new AppError(503,
          'The verified grounding envelope source map could not be resolved',
          'KNOWLEDGE_GROUNDED_SOURCE_MAP_INVALID', {
            stage: 'grounded_evidence_packaging',
            sourceId: mapping.sourceId,
            recordId: mapping.recordId,
            reason: resolved.reason,
          });
      }
    }
  }

  const authorizedTools = applicableTools(hydrated, runtimeProfile);
  const canonicalResolution = resolveCanonicalTopicMemory({
    scope: {
      tenantId: input.tenantId,
      agentId: input.agentId,
      callId: input.callId,
    },
    understanding: input.queryUnderstanding,
    evidence: allHydrated,
    memory: input.canonicalCallMemory ?? input.memory,
  });
  const requestedFact = clean(
    input?.queryUnderstanding?.requestedFact
      ?? input?.requestedFact
      ?? input?.memory?.pendingClarification?.missingFactType,
    160,
  ) || null;
  const categoryChildren = activeCategoryChildren(
    input, authoritative, canonicalResolution.activeCategory,
  );
  const categorySelection = categorySelectionContext(input, classification, categoryChildren);
  const candidates = ambiguityCandidates(
    input, authoritative, resolution, classification,
    categorySelection.detected ? categoryChildren : [],
  );
  const configuredInformationFields = resolveLiveMemoryConfiguration(
    runtimeProfile?.agent?.settings ?? {},
  ).fields;
  const permittedCollectedKeys = new Set([
    ...configuredInformationFields.map((field) => field.key),
    ...authorizedTools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {})),
  ]);
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const collected = memory.collectedInformation ?? memory.collectedToolFields ?? {};
  const relevantCollectedFields = Object.freeze(Object.fromEntries(Object.entries(collected)
    .filter(([key]) => permittedCollectedKeys.has(key))));
  const canonicalMemory = Object.freeze({
    ...compactCanonicalMemory(input, canonicalResolution),
    collectedInformation: relevantCollectedFields,
  });
  return Object.freeze({
    currentQuestion: clean(input?.latestQuestion ?? input?.utterance, 2_000),
    recentRelevantTurns: compactRelevantTurns(input),
    canonicalMemory,
    hydratedRecords,
    sourceMap,
    requestedFact,
    meaning: Object.freeze({
      authority: 'GROUNDED_LLM',
      interpretationRequired: true,
      structuredExtract: Object.freeze(object(
        input?.queryUnderstanding?.structuredMeaning,
      )),
      intentHint: clean(input?.queryUnderstanding?.intentHint, 80) || null,
      explicitEntities: Object.freeze(
        (input?.queryUnderstanding?.explicitEntities ?? []).slice(0, 5),
      ),
      explicitCategories: Object.freeze(
        (input?.queryUnderstanding?.explicitCategories ?? []).slice(0, 5),
      ),
      entityCandidates: Object.freeze(
        (input?.queryUnderstanding?.currentEntityCandidates ?? []).slice(0, 5),
      ),
      phoneticCandidates: Object.freeze(
        (input?.queryUnderstanding?.phoneticCandidates ?? []).slice(0, 5),
      ),
      confirmationCandidate: input?.queryUnderstanding?.confirmationCandidate ?? null,
      contextualReferences: Object.freeze(
        (input?.queryUnderstanding?.contextualReferences ?? [])
          .slice(0, 10).map((value) => clean(value, 160)).filter(Boolean),
      ),
      contextualEntity: input?.queryUnderstanding?.meaning?.contextualEntity ?? null,
      requestedFactHint: requestedFact,
      requestedFactInterpretationRequired:
        input?.queryUnderstanding?.meaning?.requestedFactInterpretationRequired !== false,
      comparisonEntities: Object.freeze(
        (input?.queryUnderstanding?.comparisonEntities ?? []).slice(0, 5),
      ),
      comparisonRequested:
        input?.queryUnderstanding?.meaning?.comparisonRequested === true,
      actionHint: Object.freeze(object(input?.queryUnderstanding?.actionIntent)),
      correctionHint: Object.freeze(object(
        input?.queryUnderstanding?.meaning?.correction,
      )),
      ambiguityHint: Object.freeze(object(input?.queryUnderstanding?.ambiguity)),
      needHint: Object.freeze(object(input?.queryUnderstanding?.need)),
    }),
    need: Object.freeze({
      detected: input?.queryUnderstanding?.need?.detected === true,
      interpretationMode: clean(
        input?.queryUnderstanding?.need?.interpretationMode, 80,
      ) || null,
      businessContext: Object.freeze(object(
        input?.queryUnderstanding?.need?.businessContext,
      )),
      customerProblem: clean(
        input?.queryUnderstanding?.need?.customerProblem, 800,
      ) || null,
      desiredOutcome: clean(
        input?.queryUnderstanding?.need?.desiredOutcome, 500,
      ) || null,
      requestedRecommendation: input?.queryUnderstanding?.need?.requestedRecommendation === true
        ? true : (input?.queryUnderstanding?.need?.requestedRecommendation === false
          ? false : null),
      missingDetails: Object.freeze((input?.queryUnderstanding?.need?.missingDetails ?? [])
        .slice(0, 10).map((value) => clean(value, 160)).filter(Boolean)),
    }),
    ambiguityCandidates: candidates,
    clarificationContext: Object.freeze({
      heardText: clean(input?.latestQuestion ?? input?.utterance, 2_000),
      requestedFact,
      genuineAmbiguity: input?.queryUnderstanding?.ambiguity?.detected === true
        || categorySelection.detected,
      categorySelectionRequired: categorySelection.detected,
      uniqueCategoryChild: categorySelection.uniqueChild,
      candidates,
      canonicalNames: Object.freeze(candidates.map((candidate) => candidate.name).filter(Boolean)),
      collectedFields: relevantCollectedFields,
    }),
    workflowAuthorization: Object.freeze(authorizedTools.map((entry) => Object.freeze({
      workflowEvidenceId: entry.workflowEvidenceId,
      workflowRecordId: entry.workflowRecordId,
      toolId: entry.toolId,
      toolName: entry.toolName,
      conditions: entry.conditions,
      actionConfig: entry.actionConfig,
    }))),
    toolSchemas: Object.freeze(authorizedTools.map((entry) => Object.freeze({
      name: entry.toolName,
      authorizationEvidenceId: entry.workflowEvidenceId,
      inputSchema: entry.inputSchema,
    }))),
  });
}

export async function retrieveRankHydrateGroundedTurn({
  auth, input, classification, resolution, publicationBundles,
  sparseIndexes = [], runtimeProfile,
} = {}, dependencies = {}) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    classification?.confidenceConfiguration ?? resolution?.confidenceConfiguration,
  );
  const retrievalStartedAt = performance.now();
  const directRememberedRetrieval = directRememberedFollowupRetrieval(
    input, classification, resolution,
  );
  const retrieval = directRememberedRetrieval ?? await completeStageWithin('retrieval', () => (
    searchParallelHybridCandidates({
      input, classification, resolution, publicationBundles, sparseIndexes,
      limitPerChannel: dependencies.limitPerChannel ?? 12,
    }, dependencies.retrieval)
  ), dependencies.retrievalTimeoutMs ?? env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS);
  const retrievalMs = Math.max(0, performance.now() - retrievalStartedAt);
  const hydrationStartedAt = performance.now();
  // Evidence can be declared missing only after this single authoritative
  // PostgreSQL hydration operation has completed successfully.
  const authoritative = await completeStageWithin('hydration', () => (
    rankAndHydrateAuthoritativeEvidence({
      auth, input, classification, resolution, retrieval,
      rrfK: dependencies.rrfK ?? 60,
      limit: maximumEvidenceRecords,
      confidenceConfiguration,
      minProviderScore: dependencies.minProviderScore
        ?? confidenceConfiguration.clarificationConfidence,
    }, dependencies.hydration)
  ), dependencies.hydrationTimeoutMs ?? env.VOICE_HYDRATION_TURN_TIMEOUT_MS);
  const hydrationMs = Math.max(0, performance.now() - hydrationStartedAt);
  if (authoritative.fusion.candidates.length > maximumEvidenceRecords
    || authoritative.evidence.length > maximumEvidenceRecords) {
    throw new TypeError('Grounded turn exceeded the five-record authoritative limit');
  }
  if (authoritative.hydrationQueryCount > 1) {
    throw new TypeError('Grounded turn performed more than one PostgreSQL hydration query');
  }
  assertCompleteAuthoritativeHydration(authoritative, input, classification);
  assertRequiredEvidenceInvariant(authoritative);
  const llmInput = buildGroundedLlmInput({
    input, classification, resolution, authoritative, runtimeProfile,
  });
  return Object.freeze({
    retrieval,
    authoritative,
    llmInput,
    latency: Object.freeze({ retrievalMs, hydrationMs }),
  });
}
