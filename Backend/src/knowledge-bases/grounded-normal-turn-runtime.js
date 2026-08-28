import { AppError } from '../middleware/errors.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import {
  createKnowledgeEngineDecision,
  isKnowledgeEngineInput,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
  technicalClarificationDecision,
} from '../knowledge-engine/engine-contract.js';
import { prepareKnowledgeQuery } from '../knowledge-engine/fast-query-preparation.js';
import { resolveCanonicalTopicMemory } from '../knowledge-engine/canonical-topic-memory.js';
import { buildDeterministicSourceMap } from '../knowledge-engine/deterministic-source-mapping.js';
import {
  loadPublishedEngineArtifacts,
} from '../knowledge-engine/runtime-service.js';
import { schedulePublishedArtifactRecovery } from './authoritative-artifact-recovery.js';
import { retrieveRankHydrateGroundedTurn } from './grounded-turn-evidence.js';

export const GROUNDED_NORMAL_TURN_RUNTIME_VERSION = 1;

const recoverableHydrationErrors = new Set([
  'KNOWLEDGE_AUTHORITATIVE_HYDRATION_EMPTY',
  'KNOWLEDGE_SELECTED_CANDIDATE_NOT_HYDRATED',
  'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE',
  'KNOWLEDGE_COMPARISON_HYDRATION_INCOMPLETE',
  'KNOWLEDGE_GROUNDED_PACKAGE_EMPTY',
]);

export function isRecoverableGroundedEvidenceFailure(value) {
  return recoverableHydrationErrors.has(String(value?.code ?? value ?? '').trim());
}

export async function scheduleGroundedEvidenceRecovery(
  auth, publications = [], error = {}, dependencies = {},
) {
  if (!publications.length || !isRecoverableGroundedEvidenceFailure(error)) return null;
  const affectedKnowledgeBases = new Set([
    ...(error.details?.selectedCandidates ?? []).map((candidate) => candidate.knowledgeBaseId),
    ...(error.details?.records ?? []).map((record) => record.knowledgeBaseId),
  ].filter(Boolean).map((value) => String(value).toLocaleLowerCase()));
  const affectedPublications = affectedKnowledgeBases.size
    ? publications.filter((publication) => (
      affectedKnowledgeBases.has(String(publication.knowledgeBaseId).toLocaleLowerCase())
    )) : publications;
  const scheduleRecovery = dependencies.schedulePublishedArtifactRecovery
    ?? schedulePublishedArtifactRecovery;
  return scheduleRecovery(auth, affectedPublications, error.code, dependencies)
    .catch((recoveryError) => Object.freeze([{
      scheduled: false,
      reason: recoveryError.code ?? 'artifact_recovery_schedule_failed',
    }]));
}

export function assertNonEmptyGroundedPackage(authoritative = {}, llmInput = {}) {
  const hydratedCallerFacing = (authoritative.evidence ?? []).filter((source) => (
    source?.callerFacing === true
    && source?.hydrationValidated === true
    && source?.publicationValidated === true
  ));
  const packagedCallerFacing = (llmInput.hydratedRecords ?? []).filter((source) => (
    source?.callerFacing === true
  ));
  if (!hydratedCallerFacing.length || packagedCallerFacing.length) {
    return Object.freeze(packagedCallerFacing);
  }
  throw new AppError(503,
    'Relevant caller-facing evidence was removed while building the grounded decision package',
    'KNOWLEDGE_GROUNDED_PACKAGE_EMPTY', {
      stage: 'grounded_evidence_packaging',
      hydratedCallerFacingRecordIds: hydratedCallerFacing.map((source) => source.recordId),
      hydratedCallerFacingEvidenceIds: hydratedCallerFacing.map((source) => source.id),
    });
}

function clean(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function revisions(publications = []) {
  return Object.freeze(publications.map((publication) => Object.freeze({
    knowledgeBaseId: publication.knowledgeBaseId,
    publicationRevision: publication.publicationRevision,
  })));
}

function compactEvidence(source) {
  return Object.freeze({
    id: source.sourceId ?? source.publishedEvidenceId,
    publishedEvidenceId: source.publishedEvidenceId,
    recordId: source.recordId,
    recordType: source.recordType,
    tenantId: source.tenantId,
    agentId: source.agentId,
    content: source.content,
    callerFacing: source.callerFacing,
    rank: source.rank,
    rrfScore: source.rrfScore,
    authoritativeData: source.authoritativeData,
    knowledgeBaseId: source.provenance.knowledgeBaseId,
    publicationRevision: source.provenance.publicationRevision,
    documentId: source.provenance.documentId,
    documentVersionId: source.provenance.documentVersionId,
    documentName: source.provenance.uploadedFilename,
    documentDisplayName: source.provenance.documentDisplayName,
    documentType: source.provenance.documentType,
    pageNumber: source.provenance.pageNumber,
    pageEnd: source.provenance.pageEnd,
    sourceSection: source.provenance.sourceSection,
    sourceLineStart: source.provenance.sourceLineStart,
    sourceLineEnd: source.provenance.sourceLineEnd,
    provenance: source.provenance,
    hydrationValidated: true,
    publicationValidated: true,
  });
}

function canonicalEntity(resolution, evidence) {
  const candidate = resolution?.candidate;
  if (!candidate) return null;
  const source = evidence.find((item) => item.recordId === candidate.recordId
    && item.recordType === candidate.recordType);
  const data = source?.authoritativeData ?? {};
  const category = candidate.entityType === 'CATEGORY';
  const key = clean(category
    ? (data.categoryKey ?? candidate.categoryKey)
    : (data.itemKey ?? candidate.itemKey), 160);
  const name = clean(category
    ? (data.category ?? candidate.label)
    : (data.name ?? candidate.label), 240);
  if (!key || !name) return null;
  return Object.freeze({
    id: source?.recordId ?? candidate.recordId,
    recordId: source?.recordId ?? candidate.recordId,
    recordType: category ? 'CATALOG_CATEGORY' : 'CATALOG_ITEM',
    entityType: category ? 'CATEGORY' : 'ITEM',
    key,
    name,
    category: clean(data.category, 240) || null,
    categoryKey: clean(data.categoryKey, 160) || null,
  });
}

function compactBundle(prepared, turn, publicationRevisions) {
  const evidence = turn.llmInput.hydratedRecords.map(compactEvidence);
  const callerFacing = evidence.filter((source) => source.callerFacing === true);
  const workflowIds = new Set(turn.llmInput.workflowAuthorization
    .map((authorization) => authorization.workflowEvidenceId));
  const workflow = evidence.filter((source) => workflowIds.has(source.publishedEvidenceId));
  const canonicalMemoryResolution = resolveCanonicalTopicMemory({
    scope: {
      tenantId: prepared.input.tenantId,
      agentId: prepared.input.agentId,
      callId: prepared.input.callId,
    },
    understanding: prepared.understanding,
    evidence: turn.authoritative.evidence,
    memory: prepared.input.canonicalCallMemory ?? prepared.input.memory,
  });
  const resolvedEntity = canonicalMemoryResolution.activeEntity
    ?? canonicalMemoryResolution.activeCategory
    ?? canonicalEntity(prepared.resolution, evidence);
  const entities = evidence.flatMap((source) => {
    const data = source.authoritativeData ?? {};
    if (source.recordType === 'CATALOG_ITEM' && data.itemKey && data.name) return [{
      id: source.recordId, recordId: source.recordId, recordType: source.recordType,
      entityType: 'ITEM', key: data.itemKey, name: data.name,
      category: data.category ?? null, categoryKey: data.categoryKey ?? null,
      aliases: data.aliases ?? [],
    }];
    if (source.recordType === 'CATALOG_CATEGORY' && data.categoryKey && data.category) return [{
      id: source.recordId, recordId: source.recordId, recordType: source.recordType,
      entityType: 'CATEGORY', key: data.categoryKey, name: data.category,
      category: data.category, categoryKey: data.categoryKey,
      aliases: data.categoryAliases ?? [],
    }];
    return [];
  });
  return Object.freeze({
    version: GROUNDED_NORMAL_TURN_RUNTIME_VERSION,
    decisionInput: turn.llmInput,
    latestQuestion: turn.llmInput.currentQuestion,
    callMemory: turn.llmInput.canonicalMemory,
    canonicalMemoryResolution,
    canonicalEntity: resolvedEntity,
    entities: Object.freeze(entities.slice(0, 5)),
    requestedFact: turn.llmInput.requestedFact,
    requestedFacts: Object.freeze(turn.llmInput.requestedFact
      ? [turn.llmInput.requestedFact] : []),
    ambiguityCandidates: turn.llmInput.ambiguityCandidates,
    recentRelevantTurns: turn.llmInput.recentRelevantTurns,
    intentClass: prepared.intentClass,
    topEvidence: Object.freeze(callerFacing),
    sourceMap: buildDeterministicSourceMap(callerFacing),
    conversationGuidance: Object.freeze([]),
    workflowAuthorization: turn.llmInput.workflowAuthorization,
    authorizedToolSchemas: turn.llmInput.toolSchemas,
    actionAuthorizationEvidence: Object.freeze(workflow.map((source) => Object.freeze({
      ...source, activationAllowed: true, retrievalContext: 'primary',
    }))),
    publicationRevisions,
  });
}

function priorityDecision(prepared, evidence) {
  if (!prepared.priorityIntent) return null;
  const preferredRecordType = prepared.intentClass === 'SAFETY_EMERGENCY'
    ? 'WORKFLOW_RULE' : 'CONVERSATION_NODE';
  const source = evidence.find((item) => item.recordType === preferredRecordType)
    ?? evidence.find((item) => ['WORKFLOW_RULE', 'CONVERSATION_NODE'].includes(item.recordType));
  const data = source?.authoritativeData ?? {};
  const text = clean(data.responseTemplate ?? data.response ?? data.content ?? source?.content);
  if (!source || !text) return technicalClarificationDecision('priority_protocol_evidence_missing');
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
    reason: 'published_priority_protocol_response',
    confidence: prepared.classification.confidence,
    evidenceIds: [source.id],
    mode: knowledgeEngineResponseModes.DETERMINISTIC,
    response: { text, recordId: source.recordId, recordType: source.recordType },
  });
}

function normalDecision(prepared, evidence) {
  const callerFacing = evidence.filter((source) => source.callerFacing === true);
  if (!callerFacing.length) return technicalClarificationDecision('grounded_evidence_unavailable');
  return createKnowledgeEngineDecision(knowledgeEngineDecisionTypes.RESPONSE, {
    reason: 'single_grounded_llm_required',
    confidence: prepared.classification.confidence,
    evidenceIds: callerFacing
      .map((source) => source.id ?? source.publishedEvidenceId)
      .filter(Boolean),
    mode: knowledgeEngineResponseModes.GROUNDED_LLM,
  });
}

export async function retrieveGroundedNormalTurn(auth, input, dependencies = {}) {
  if (!isKnowledgeEngineInput(input)) {
    throw new AppError(400, 'A versioned knowledge-engine input is required',
      'KNOWLEDGE_ENGINE_INPUT_INVALID');
  }
  let artifacts = null;
  const startedAt = performance.now();
  try {
    artifacts = await loadPublishedEngineArtifacts(auth, input, dependencies);
    const routingStartedAt = performance.now();
    const prepared = await prepareKnowledgeQuery(input, artifacts.bundles, {}, {
      resolve: dependencies.resolve,
      classify: dependencies.classify,
    });
    const routingMs = Math.max(0, performance.now() - routingStartedAt);
    const turn = await retrieveRankHydrateGroundedTurn({
      auth,
      input: prepared.input,
      classification: prepared.classification,
      resolution: prepared.resolution,
      publicationBundles: artifacts.bundles,
      sparseIndexes: artifacts.sparseIndexes,
      runtimeProfile: dependencies.runtimeProfile,
    }, {
      retrieval: dependencies.retrievalDependencies,
      hydration: {
        contextRunner: dependencies.contextRunner ?? withTenantContext,
      },
    });
    const publicationRevisions = revisions(artifacts.publications);
    const evidence = turn.authoritative.evidence;
    const packagedCallerFacing = assertNonEmptyGroundedPackage(
      turn.authoritative, turn.llmInput,
    );
    const decision = priorityDecision(prepared, evidence)
      ?? normalDecision(prepared, packagedCallerFacing);
    const llmEvidenceBundle = compactBundle(prepared, turn, publicationRevisions);
    const packagedEvidenceIds = new Set(packagedCallerFacing
      .map((source) => source.publishedEvidenceId)
      .filter(Boolean));
    const sources = Object.freeze(evidence.filter((source) => (
      source.callerFacing === true && packagedEvidenceIds.has(source.id)
    )));
    const authorizedWorkflowIds = new Set(turn.llmInput.workflowAuthorization
      .map((authorization) => authorization.workflowEvidenceId));
    const actionEvidence = Object.freeze(evidence
      .filter((source) => source.recordType === 'WORKFLOW_RULE')
      .map((source) => Object.freeze({
        ...source,
        activationAllowed: authorizedWorkflowIds.has(source.id),
        retrievalContext: 'primary',
      })));
    const guidanceEvidence = Object.freeze(evidence.filter((source) => (
      source.recordType === 'CONVERSATION_NODE' && source.callerFacing === false
    )));
    return Object.freeze({
      operation: 'grounded_normal_turn',
      engineVersion: GROUNDED_NORMAL_TURN_RUNTIME_VERSION,
      route: 'single_grounded_llm',
      found: evidence.length > 0,
      cancelled: input.abortSignal?.aborted === true,
      sources,
      actionEvidence,
      guidanceEvidence,
      entities: Object.freeze(llmEvidenceBundle.canonicalEntity
        ? [llmEvidenceBundle.canonicalEntity] : []),
      evidenceIds: Object.freeze(sources.map((source) => source.id)),
      publicationRevisions,
      decision,
      llmEvidenceBundle,
      classification: prepared.classification,
      resolution: prepared.resolution,
      authoritative: turn.authoritative,
      retrieval: Object.freeze({
        candidateCount: turn.retrieval.candidateCount,
        searchedIndexes: turn.retrieval.searchedIndexes,
        channels: Object.freeze(Object.fromEntries(['structured', 'bm25', 'qdrant']
          .map((channel) => [channel, turn.retrieval.channels[channel].length]))),
        conflictDetected: turn.authoritative.conflict.detected,
        ambiguityDetected: turn.authoritative.ambiguity.detected,
      }),
      retrievalTrace: Object.freeze({
        primaryQuery: prepared.input.utterance,
        retrievedCandidates: turn.authoritative.fusion.candidates,
        hydratedEvidence: evidence,
        permittedEvidenceIds: sources.map((source) => source.id),
        sourceMap: llmEvidenceBundle.sourceMap,
        rejectedCandidates: turn.authoritative.rejectedRecordIds ?? [],
        publicationRevisions,
      }),
      latency: Object.freeze({
        totalMs: Math.max(0, performance.now() - startedAt),
        stages: Object.freeze({
          routingMs,
          retrievalMs: turn.latency.retrievalMs,
          hydrationMs: turn.latency.hydrationMs,
        }),
      }),
    });
  } catch (error) {
    if (dependencies.throwOnError === true) throw error;
    let recovery = null;
    recovery = await scheduleGroundedEvidenceRecovery(
      auth, artifacts?.publications ?? [], error, dependencies,
    );
    return Object.freeze({
      operation: 'grounded_normal_turn',
      engineVersion: GROUNDED_NORMAL_TURN_RUNTIME_VERSION,
      route: 'single_grounded_llm',
      found: false,
      cancelled: input.abortSignal?.aborted === true,
      error: error.code ?? 'KNOWLEDGE_ENGINE_UNAVAILABLE',
      sources: Object.freeze([]),
      actionEvidence: Object.freeze([]),
      guidanceEvidence: Object.freeze([]),
      entities: Object.freeze([]),
      evidenceIds: Object.freeze([]),
      publicationRevisions: revisions(artifacts?.publications),
      decision: technicalClarificationDecision(
        input.abortSignal?.aborted ? 'knowledge_cancelled' : (error.code ?? 'knowledge_engine_unavailable'),
      ),
      diagnostic: Object.freeze({
        stage: error.details?.stage ?? 'grounded_normal_turn_unavailable',
        errorCode: error.code ?? 'KNOWLEDGE_ENGINE_UNAVAILABLE',
        operationalFailure: true,
        ambiguity: false,
        artifactRecoveryTriggered: Array.isArray(recovery),
        details: Object.freeze({ ...(error.details ?? {}), recovery }),
      }),
    });
  }
}
