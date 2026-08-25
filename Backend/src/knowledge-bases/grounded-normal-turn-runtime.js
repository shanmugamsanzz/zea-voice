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
import { loadPublishedEngineArtifacts } from '../knowledge-engine/runtime-service.js';
import { retrieveRankHydrateGroundedTurn } from './grounded-turn-evidence.js';

export const GROUNDED_NORMAL_TURN_RUNTIME_VERSION = 1;

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
    id: source.publishedEvidenceId,
    recordId: source.recordId,
    recordType: source.recordType,
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
  const source = evidence.find((item) => item.recordId === candidate.recordId);
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
  const evidence = turn.llmInput.evidence.map(compactEvidence);
  const callerFacing = evidence.filter((source) => source.callerFacing === true);
  const workflowIds = new Set(turn.llmInput.workflowAuthorization
    .map((authorization) => authorization.workflowEvidenceId));
  const workflow = evidence.filter((source) => workflowIds.has(source.id));
  const guidance = evidence.filter((source) => (
    source.recordType === 'CONVERSATION_NODE' && source.callerFacing === false
  )).slice(0, 1);
  return Object.freeze({
    version: GROUNDED_NORMAL_TURN_RUNTIME_VERSION,
    latestQuestion: turn.llmInput.currentQuestion,
    canonicalEntity: canonicalEntity(prepared.resolution, evidence),
    requestedFact: prepared.requestedFact,
    requestedFacts: prepared.requestedFacts,
    recentRelevantTurns: turn.llmInput.memory.recentTurns,
    intentClass: prepared.intentClass,
    topEvidence: Object.freeze(callerFacing),
    sourceMap: Object.freeze(callerFacing.map((source, index) => Object.freeze({
      sourceId: `source_${index + 1}`,
      publishedEvidenceId: source.id,
      recordId: source.recordId,
      recordType: source.recordType,
      knowledgeBaseId: source.knowledgeBaseId,
      publicationRevision: source.publicationRevision,
    }))),
    conversationGuidance: Object.freeze(guidance),
    authorizedToolSchemas: turn.llmInput.assignedToolSchemas,
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
    evidenceIds: callerFacing.map((source) => source.id),
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
    const decision = priorityDecision(prepared, evidence) ?? normalDecision(prepared, evidence);
    const llmEvidenceBundle = compactBundle(prepared, turn, publicationRevisions);
    const sources = Object.freeze(evidence.filter((source) => source.callerFacing === true));
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
        stage: 'grounded_normal_turn_unavailable',
        errorCode: error.code ?? 'KNOWLEDGE_ENGINE_UNAVAILABLE',
        details: error.details ?? null,
      }),
    });
  }
}
