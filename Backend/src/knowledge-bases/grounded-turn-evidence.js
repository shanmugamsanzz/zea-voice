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
import {
  createCanonicalGroundedEvidence,
} from '../knowledge-engine/grounded-evidence-representation.js';
import { env } from '../config/env.js';

export const GROUNDED_TURN_EVIDENCE_VERSION = 3;
const maximumEvidenceRecords = 5;

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
  const requiredReasons = new Set([
    'explicit_current_entity', 'explicit_entity', 'explicit_comparison',
    'canonical_memory', 'published_overview', 'published_use_case', 'latest_request_record',
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
  });
}

function compactRelevantTurns(input = {}) {
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const understanding = input.queryUnderstanding ?? {};
  const currentEntityTerms = (understanding.currentEntityCandidates ?? [])
    .flatMap((candidate) => [candidate?.name, candidate?.canonicalName]).filter(Boolean);
  return Object.freeze(selectCompleteConversationTurns(input.recentRelevantTurns
    ?? memory.recentConversation ?? memory.recentTurns ?? [], {
    mode: memory.conversationContextMode,
    recentTurns: memory.conversationContextTurns,
    currentQuestion: input.currentQuestion ?? input.latestQuestion ?? input.utterance,
    contextTerms: currentEntityTerms.length ? currentEntityTerms
      : [memory.activeEntity?.name, memory.activeCategory?.name].filter(Boolean),
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
  const allHydrated = authoritative?.verifiedRecords ?? authoritative?.evidence ?? [];
  const hydrated = allHydrated;
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
    const reasons = reservationReasons(source);
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
      genuineAmbiguity: input?.queryUnderstanding?.ambiguity?.detected === true,
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
  const retrieval = await completeStageWithin('retrieval', () => (
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
