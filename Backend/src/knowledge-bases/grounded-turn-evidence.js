import {
  rankAndHydrateAuthoritativeEvidence,
} from '../knowledge-engine/authoritative-evidence.js';
import { searchParallelHybridCandidates } from './parallel-hybrid-search.js';
import { resolveCanonicalTopicMemory } from '../knowledge-engine/canonical-topic-memory.js';
import {
  canonicalRecordIdentityKey,
} from '../knowledge-engine/canonical-record-identity.js';
import { buildDeterministicSourceMap } from '../knowledge-engine/deterministic-source-mapping.js';
import { AppError } from '../middleware/errors.js';
import { resolveKnowledgeConfidenceConfiguration } from './knowledge-confidence-config.js';
import { selectCompleteConversationTurns } from '../knowledge-engine/conversation-turn-context.js';
import { resolveLiveMemoryConfiguration } from '../voice/interaction/live-memory-config.js';

export const GROUNDED_TURN_EVIDENCE_VERSION = 2;
const maximumEvidenceRecords = 5;

const namespaceRecordTypes = Object.freeze({
  CATALOG: new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']),
  FAQ: new Set(['FAQ']),
  CONVERSATION: new Set(['CONVERSATION_NODE']),
  WORKFLOW: new Set(['WORKFLOW_RULE']),
  CALL_CONTROL: new Set(['WORKFLOW_RULE']),
  GENERAL: new Set(['KNOWLEDGE_CHUNK', 'GENERAL_KNOWLEDGE']),
});

const catalogIntentClasses = new Set([
  'DETAILS_OR_PRICE', 'CATEGORY_OVERVIEW', 'COMPARISON_COMPLEX',
]);

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

function relevantHydratedEvidence(
  sources, classification = {}, resolution = {}, input = {}, authoritative = {},
) {
  const intentClass = String(classification.intentClass ?? '').trim().toUpperCase();
  const understanding = input?.queryUnderstanding ?? {};
  const namespace = intendedNamespace(classification, resolution, understanding);
  const selectedTypes = namespaceRecordTypes[namespace]
    ?? (catalogIntentClasses.has(intentClass) ? namespaceRecordTypes.CATALOG : null);
  const rememberedTool = input?.memory?.activeTool ?? input?.canonicalCallMemory?.activeTool;
  const actionTurn = intentClass === 'ACTION_TOOL_REQUEST'
    || (!namespace && Boolean(rememberedTool));
  const protocolTurn = ['SAFETY_EMERGENCY', 'CALL_CONTROL'].includes(intentClass);
  const currentRoute = understanding.explicitCurrentRoute
    ?? understanding.currentRouteSignal
    ?? null;
  const authoritativeCurrentRoute = authoritativeRoute(understanding, currentRoute);
  const currentRouteType = String(
    authoritativeCurrentRoute?.recordType ?? currentRoute?.recordType ?? '',
  ).toUpperCase();
  const currentRouteKey = reservationKey(authoritativeCurrentRoute ?? currentRoute);
  const currentRouteHydrated = Boolean(currentRouteKey)
    && sources.some((source) => reservationKey(source) === currentRouteKey);
  const currentNonCatalogRequest = currentRouteHydrated
    && Boolean(currentRouteType)
    && !['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(currentRouteType);
  const explicitCandidates = [
    ...(understanding.explicitEntities ?? []),
    ...(understanding.explicitCategories ?? []),
    ...(understanding.comparisonEntities ?? []),
    ...(resolution?.candidate?.explicit === true ? [resolution.candidate] : []),
  ];
  const selectedCandidates = [
    ...(resolution?.candidate?.explicit === true
      ? [resolution.candidate.recordId, ...(resolution.candidate.evidenceRecordIds ?? [])]
        .map((recordId) => ({
          ...resolution.candidate,
          recordId,
          recordType: resolution.candidate.recordType
            ?? (resolution.candidate.entityType === 'CATEGORY'
              ? 'CATALOG_CATEGORY' : 'CATALOG_ITEM'),
        })) : []),
    ...explicitCandidates,
    ...requiredReservations(authoritative),
    ...(authoritativeCurrentRoute ? [authoritativeCurrentRoute] : []),
  ].filter(Boolean);
  const hasExplicitCurrentEntity = explicitCandidates.length > 0;
  const contextDependent = understanding.contextDependent === true
    || resolution?.contextDependent === true;
  if (!hasExplicitCurrentEntity && contextDependent) {
    for (const remembered of [
      [input?.canonicalCallMemory?.activeCategory, 'CATALOG_CATEGORY'],
      [input?.canonicalCallMemory?.activeEntity, 'CATALOG_ITEM'],
      [input?.memory?.activeCategory, 'CATALOG_CATEGORY'],
      [input?.memory?.activeEntity, 'CATALOG_ITEM'],
    ]) {
      const [value, recordType] = remembered;
      if (value?.recordId ?? value?.id) selectedCandidates.push({ ...value, recordType });
    }
  }
  const sourceKeys = new Map(sources.map((source) => [canonicalEvidenceKey(source, input), source]));
  const selectedKeys = new Set();
  const unscopedTypedKeys = new Set(sources.filter((source) => (
    !canonicalRecordIdentityKey(source, {
      tenantId: source?.tenantId ?? input?.tenantId,
      knowledgeBaseId: source?.knowledgeBaseId,
      publicationRevision: source?.publicationRevision,
    })
  )).map(reservationKey).filter(Boolean));
  const selectedUnscopedTypedKeys = new Set();
  const selectedPriority = new Map();
  for (const [priority, candidate] of selectedCandidates.entries()) {
    const typedKey = reservationKey(candidate);
    if (typedKey && unscopedTypedKeys.has(typedKey)) selectedUnscopedTypedKeys.add(typedKey);
    for (const key of matchingCanonicalEvidenceKeys(candidate, sources, input)) {
      selectedKeys.add(key);
      if (!selectedPriority.has(key)) selectedPriority.set(key, priority);
    }
  }
  const filtered = sources.filter((source) => {
    const recordType = String(source.recordType ?? '').toUpperCase();
    const sourceKey = canonicalEvidenceKey(source, input);
    const sourceTypedKey = reservationKey(source);
    const actionType = String(source.authoritativeData?.actionType ?? '').toLowerCase();
    const callerFacingWorkflowResponse = recordType === 'WORKFLOW_RULE'
      && source.callerFacing === true && actionType === 'respond';
    if (selectedKeys.has(sourceKey)
      || (sourceKey?.includes(':unscoped:')
        && selectedUnscopedTypedKeys.has(sourceTypedKey))) return true;
    if (callerFacingWorkflowResponse) return !hasExplicitCurrentEntity
      || currentNonCatalogRequest;
    if (recordType === 'WORKFLOW_RULE') return actionTurn || protocolTurn;
    if (currentNonCatalogRequest
      && ['KNOWLEDGE_CHUNK', 'GENERAL_KNOWLEDGE'].includes(recordType)) {
      return source.callerFacing === true;
    }
    if (currentNonCatalogRequest
      && ['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(recordType)) return false;
    if (intentClass === 'CATEGORY_OVERVIEW'
      && recordType === 'CATALOG_CATEGORY' && source.callerFacing === true) return true;
    // A resolver route that was not part of the authoritative hydrated set
    // must not discard every valid record. Restrictive selection applies only
    // to canonical identities that are present in this same tenant-scoped
    // PostgreSQL result.
    if (selectedKeys.size > 0 || selectedUnscopedTypedKeys.size > 0) return false;
    if (selectedTypes) return selectedTypes.has(recordType);
    if (intentClass === 'ACKNOWLEDGEMENT') {
      return ['CONVERSATION_NODE', 'FAQ'].includes(recordType);
    }
    // With no resolved namespace, retain caller-facing discovery evidence.
    // Internal Workflow records are admitted only by the action/protocol rule
    // above, so unrelated authorization cannot influence a normal answer.
    return source.callerFacing === true;
  });
  return filtered.sort((left, right) => {
    const leftKey = canonicalEvidenceKey(left, input);
    const rightKey = canonicalEvidenceKey(right, input);
    const leftSelected = selectedKeys.has(leftKey)
      || (leftKey?.includes(':unscoped:')
        && selectedUnscopedTypedKeys.has(reservationKey(left))) ? 0 : 1;
    const rightSelected = selectedKeys.has(rightKey)
      || (rightKey?.includes(':unscoped:')
        && selectedUnscopedTypedKeys.has(reservationKey(right))) ? 0 : 1;
    return leftSelected - rightSelected
      || Number(selectedPriority.get(leftKey) ?? 999) - Number(selectedPriority.get(rightKey) ?? 999)
      || Number(sourceKeys.get(leftKey)?.rank ?? left.rank ?? 999)
        - Number(sourceKeys.get(rightKey)?.rank ?? right.rank ?? 999);
  });
}

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return clean(value, 240).toLocaleLowerCase();
}

function namespaceForRecordType(value) {
  const recordType = clean(value, 80).toUpperCase();
  if (['CATALOG_ITEM', 'CATALOG_CATEGORY'].includes(recordType)) return 'CATALOG';
  if (recordType === 'FAQ') return 'FAQ';
  if (recordType === 'CONVERSATION_NODE') return 'CONVERSATION';
  if (recordType === 'WORKFLOW_RULE') return 'WORKFLOW';
  if (['KNOWLEDGE_CHUNK', 'GENERAL_KNOWLEDGE'].includes(recordType)) return 'GENERAL';
  return null;
}

function authoritativeRoute(understanding = {}, route = null) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    understanding?.confidenceConfiguration,
  );
  if (!route?.recordId || !route?.recordType) return null;
  if (route === understanding.explicitCurrentRoute) return route;
  if (route.explicit === true
    && Number(route.score ?? 0) >= confidenceConfiguration.highConfidence) return route;
  // A prevalidated route may omit scoring metadata in internal callers. A
  // scored medium route is never promoted by this compatibility branch.
  if (route.explicit === undefined && route.score === undefined) return route;
  return null;
}

function intendedNamespace(classification = {}, resolution = {}, understanding = {}) {
  if ((understanding.explicitEntities?.length ?? 0) > 0
    || (understanding.explicitCategories?.length ?? 0) > 0
    || (understanding.comparisonEntities?.length ?? 0) > 0) return 'CATALOG';
  const currentRoute = understanding.explicitCurrentRoute
    ?? understanding.currentRouteSignal ?? null;
  const authoritativeCurrentRoute = authoritativeRoute(understanding, currentRoute);
  const explicitNamespace = namespaceForRecordType(authoritativeCurrentRoute?.recordType);
  if (explicitNamespace) return explicitNamespace;
  const intentClass = clean(classification.intentClass, 80).toUpperCase();
  if (catalogIntentClasses.has(intentClass)) return 'CATALOG';
  if (['ACTION_TOOL_REQUEST', 'SAFETY_EMERGENCY', 'CALL_CONTROL'].includes(intentClass)) {
    return 'WORKFLOW';
  }
  // A weak resolver namespace is not sufficient to discard evidence from the
  // other independently searched namespaces. The grounded decision receives
  // the fused caller-facing candidates and may clarify genuine ambiguity.
  return null;
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
  const requiredReasons = new Set([
    'explicit_current_entity', 'explicit_entity', 'explicit_comparison',
    'canonical_memory', 'published_overview',
  ]);
  return (authoritative.reservations ?? []).filter((entry) => (
    requiredReasons.has(entry.reason)
  ));
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
  return Object.freeze({
    activeEntity: canonicalResolution.activeEntity ?? null,
    activeCategory: canonicalResolution.activeCategory ?? null,
    comparisonEntities: Object.freeze([...(canonicalResolution.comparisonEntities ?? [])]
      .slice(0, maximumEvidenceRecords)),
    pendingClarification: compactValue(memory.pendingClarification),
    activeTool: compactValue(memory.activeTool),
    collectedToolFields: Object.freeze({ ...(memory.collectedToolFields ?? {}) }),
  });
}

function compactRelevantTurns(input = {}) {
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  return Object.freeze(selectCompleteConversationTurns(input.recentRelevantTurns
    ?? memory.recentConversation ?? memory.recentTurns ?? [], {
    mode: memory.conversationContextMode,
    recentTurns: memory.conversationContextTurns,
    currentQuestion: input.currentQuestion ?? input.latestQuestion ?? input.utterance,
    contextTerms: [memory.activeEntity?.name, memory.activeCategory?.name].filter(Boolean),
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

function ambiguityCandidates(input = {}, authoritative = {}, resolution = {}, classification = {}) {
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

function compactEvidence(source, sourceId) {
  const provenance = source.provenance ?? {};
  return Object.freeze({
    sourceId,
    publishedEvidenceId: source.id,
    recordId: source.recordId,
    recordType: source.recordType,
    tenantId: source.tenantId,
    agentId: source.agentId,
    content: clean(source.content, 2_500),
    callerFacing: source.callerFacing === true,
    rank: source.rank,
    rrfScore: source.rrfScore,
    authoritativeData: compactValue(source.authoritativeData),
    provenance: Object.freeze({
      knowledgeBaseId: source.knowledgeBaseId,
      publicationRevision: source.publicationRevision,
      documentId: source.documentId,
      documentVersionId: source.documentVersionId,
      uploadedFilename: provenance.uploadedFilename ?? source.documentName ?? null,
      documentDisplayName: provenance.documentDisplayName ?? source.documentDisplayName ?? null,
      documentType: provenance.documentType ?? source.documentType ?? null,
      pageNumber: provenance.pageNumber ?? source.pageNumber ?? null,
      pageEnd: provenance.pageEnd ?? source.pageEnd ?? null,
      sourceSection: provenance.sourceSection ?? source.sourceSection ?? null,
      sourceLineStart: provenance.sourceLineStart ?? source.sourceLineStart ?? null,
      sourceLineEnd: provenance.sourceLineEnd ?? source.sourceLineEnd ?? null,
    }),
  });
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
        toolName: clean(tool.name, 160),
        inputSchema: compactValue(inputSchema),
      }));
    }
  }
  return Object.freeze(results.slice(0, 3));
}

export function buildGroundedLlmInput({
  input, classification, resolution, authoritative, runtimeProfile,
} = {}) {
  const allHydrated = (authoritative?.evidence ?? []).filter((source) => (
    source.hydrationValidated === true && source.publicationValidated === true
  ));
  const hydrated = relevantHydratedEvidence(
    allHydrated, classification, resolution, input, authoritative,
  ).slice(0, maximumEvidenceRecords);
  assertRequiredEvidenceInvariant(authoritative, hydrated);
  if (hydrated.length > maximumEvidenceRecords) {
    throw new TypeError('Grounded LLM input cannot contain more than five hydrated records');
  }
  let callerSourceIndex = 0;
  const hydratedRecords = Object.freeze(hydrated.map((source) => (
    compactEvidence(source, source.callerFacing === true
      ? `source_${callerSourceIndex += 1}` : null)
  )));
  const sourceMap = buildDeterministicSourceMap(hydratedRecords.filter((source) => source.sourceId));

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
  const candidates = ambiguityCandidates(input, authoritative, resolution, classification);
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
  return Object.freeze({
    currentQuestion: clean(input?.latestQuestion ?? input?.utterance, 2_000),
    recentRelevantTurns: compactRelevantTurns(input),
    canonicalMemory: compactCanonicalMemory(input, canonicalResolution),
    hydratedRecords,
    sourceMap,
    requestedFact,
    ambiguityCandidates: candidates,
    clarificationContext: Object.freeze({
      heardText: clean(input?.latestQuestion ?? input?.utterance, 2_000),
      requestedFact,
      candidates,
      canonicalNames: Object.freeze(candidates.map((candidate) => candidate.name).filter(Boolean)),
      collectedFields: relevantCollectedFields,
    }),
    workflowAuthorization: Object.freeze(authorizedTools.map((entry) => Object.freeze({
      workflowEvidenceId: entry.workflowEvidenceId,
      workflowRecordId: entry.workflowRecordId,
      toolName: entry.toolName,
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
  const retrieval = await searchParallelHybridCandidates({
    input, classification, resolution, publicationBundles, sparseIndexes,
    limitPerChannel: dependencies.limitPerChannel ?? 12,
  }, dependencies.retrieval);
  const retrievalMs = Math.max(0, performance.now() - retrievalStartedAt);
  const hydrationStartedAt = performance.now();
  const authoritative = await rankAndHydrateAuthoritativeEvidence({
    auth, input, classification, resolution, retrieval,
    rrfK: dependencies.rrfK ?? 60,
    limit: maximumEvidenceRecords,
    confidenceConfiguration,
    minProviderScore: dependencies.minProviderScore
      ?? confidenceConfiguration.clarificationConfidence,
  }, dependencies.hydration);
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
