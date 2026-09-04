import { createKnowledgeEngineInput } from '../../knowledge-engine/engine-contract.js';
import { canonicalRecordIdentityKey } from '../../knowledge-engine/canonical-record-identity.js';
import { rankAndHydrateAuthoritativeEvidence } from '../../knowledge-engine/authoritative-evidence.js';
import { AppError } from '../../middleware/errors.js';
import { knowledgeSearchIndexes } from '../../knowledge-engine/query-classifier.js';
import { loadPublishedEngineArtifacts } from '../../knowledge-engine/runtime-service.js';
import { searchParallelHybridCandidates } from '../../knowledge-bases/parallel-hybrid-search.js';
import { runTemplateEngineHybridRetrieval } from './template-engine-hybrid-retrieval.js';
import { normalizePublishedConversationGuidance } from './template-engine-conversation-guidance.js';

export const TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION = 1;

const namespaces = Object.freeze(['CATALOG', 'FAQ', 'GENERAL', 'CONVERSATION', 'WORKFLOW']);
const indexes = Object.freeze([
  knowledgeSearchIndexes.CATALOG,
  knowledgeSearchIndexes.FAQ,
  knowledgeSearchIndexes.GENERAL,
  knowledgeSearchIndexes.CONVERSATION,
  knowledgeSearchIndexes.WORKFLOW,
  knowledgeSearchIndexes.BM25,
  knowledgeSearchIndexes.SEMANTIC,
]);

function classification(input, search) {
  return Object.freeze({
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    intentClass: 'TEMPLATE_SEARCH',
    confidence: 1,
    relevantNamespaces: namespaces,
    primaryNamespaces: namespaces,
    requestedFacts: Object.freeze(search.requestedFact ? [search.requestedFact] : []),
    retrievalPlan: Object.freeze({ indexes, parallelChannels: Object.freeze([
      'structured', 'bm25', 'qdrant',
    ]) }),
  });
}

function evidenceRecord(source) {
  const provenance = source.provenance ?? {};
  return Object.freeze({
    verified: source.hydrationValidated === true && source.publicationValidated === true,
    callerFacing: source.callerFacing === true,
    evidenceId: source.id,
    recordId: source.recordId,
    recordType: source.recordType,
    tenantId: source.tenantId,
    agentId: source.agentId,
    knowledgeBaseId: provenance.knowledgeBaseId ?? source.knowledgeBaseId,
    publicationRevision: Number(provenance.publicationRevision ?? source.publicationRevision),
    documentId: provenance.documentId ?? source.documentId,
    documentVersionId: provenance.documentVersionId ?? source.documentVersionId,
    documentName: provenance.uploadedFilename ?? provenance.documentName
      ?? source.uploadedFilename ?? source.documentName,
    documentDisplayName: provenance.documentDisplayName ?? source.documentDisplayName,
    documentType: provenance.documentType ?? source.documentType,
    pageNumber: provenance.pageNumber ?? source.pageNumber,
    pageEnd: provenance.pageEnd ?? source.pageEnd,
    sourceSection: provenance.sourceSection ?? source.sourceSection,
    sourceLineStart: provenance.sourceLineStart ?? source.sourceLineStart ?? source.sourceLine,
    sourceLineEnd: provenance.sourceLineEnd ?? source.sourceLineEnd,
    content: source.content ?? JSON.stringify(source.authoritativeData ?? source.facts ?? {}),
    canonicalName: source.canonicalName
      ?? source.authoritativeData?.name
      ?? source.authoritativeData?.category
      ?? null,
    aliases: source.authoritativeData?.aliases
      ?? source.authoritativeData?.categoryAliases
      ?? [],
    relationships: source.authoritativeData?.relationships ?? [],
    authoritativeData: source.authoritativeData ?? source.facts ?? {},
  });
}

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function verifyTemplateEngineEvidence(evidence, selectedCandidates, scope) {
  const publications = new Set(scope.publications.map((entry) => (
    `${normalized(entry.knowledgeBaseId)}:${Number(entry.publicationRevision)}`
  )));
  const selectedKeys = new Set(selectedCandidates.map((candidate) => (
    canonicalRecordIdentityKey(candidate, { tenantId: scope.tenantId })
  )).filter(Boolean));
  for (const source of evidence) {
    const publicationKey = `${normalized(source.knowledgeBaseId)}:${source.publicationRevision}`;
    const identityKey = canonicalRecordIdentityKey(source);
    const crossScope = normalized(source.tenantId) !== normalized(scope.tenantId)
      || (source.agentId && normalized(source.agentId) !== normalized(scope.agentId))
      || !publications.has(publicationKey);
    if (crossScope) {
      throw new AppError(500, 'PostgreSQL evidence is outside the template-engine scope',
        'TEMPLATE_ENGINE_HYDRATION_SCOPE_VIOLATION', {
          recordType: source.recordType || null,
        });
    }
    if (source.verified !== true || source.callerFacing !== true
      || !identityKey || !selectedKeys.has(identityKey) || !source.content) {
      throw new AppError(503, 'PostgreSQL evidence failed template-engine verification',
        'TEMPLATE_ENGINE_HYDRATED_EVIDENCE_INVALID', {
          recordType: source.recordType || null,
        });
    }
  }
  return Object.freeze(evidence);
}

function publishedWorkflowRecord(record, publication, agentId) {
  const recordType = String(record?.record_type ?? record?.recordType ?? '').toLocaleUpperCase();
  if (recordType !== 'WORKFLOW_RULE') return null;
  const metadata = record.entity_metadata && typeof record.entity_metadata === 'object'
    ? record.entity_metadata : {};
  const recordId = String(record.record_id ?? record.recordId ?? '').trim();
  if (!recordId) return null;
  return Object.freeze({
    ...metadata,
    id: recordId,
    recordId,
    recordType,
    tenantId: publication.tenantId,
    agentId,
    knowledgeBaseId: publication.knowledgeBaseId,
    publicationRevision: publication.publicationRevision,
    published: true,
    status: 'published',
    authoritativeData: metadata,
  });
}

export async function loadTemplateEnginePublishedContext({
  auth, scope, callId, usageDirection, language,
} = {}, dependencies = {}) {
  const input = createKnowledgeEngineInput({
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    callId,
    utterance: 'template engine published runtime context',
    usageDirection,
    language,
  });
  const artifacts = await (dependencies.loadArtifacts ?? loadPublishedEngineArtifacts)(
    auth, input, dependencies.artifacts,
  );
  const publishedWorkflows = artifacts.bundles.flatMap((bundle, index) => (
    (bundle.records ?? []).map((record) => publishedWorkflowRecord(
      record, artifacts.publications[index], scope.agentId,
    )).filter(Boolean)
  ));
  const publishedConversationGuidance = artifacts.bundles.flatMap((bundle, index) => (
    (bundle.records ?? []).map((record) => normalizePublishedConversationGuidance(
      record,
      { ...artifacts.publications[index], tenantId: scope.tenantId },
      scope.agentId,
    )).filter(Boolean)
  ));
  return Object.freeze({
    artifacts,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    publishedWorkflows: Object.freeze(publishedWorkflows),
    publishedConversationGuidance: Object.freeze(publishedConversationGuidance),
  });
}

export async function retrieveTemplateEngineEvidence({
  auth, scope, callId, usageDirection, language, searchDecision, state = {}, runtimeProfile,
  preloadedArtifacts = null,
} = {}, dependencies = {}) {
  const startedAt = performance.now();
  const search = searchDecision?.search;
  if (!search?.query) throw new TypeError('Template-engine retrieval requires SEARCH output');
  const input = createKnowledgeEngineInput({
    tenantId: scope.tenantId,
    agentId: scope.agentId,
    callId,
    utterance: search.query,
    usageDirection,
    language,
    requestedFacts: search.requestedFact ? [search.requestedFact] : [],
    contextualReferences: search.contextualReference ? [search.contextualReference] : [],
    recentRelevantTurns: state.recentCompleteTurns ?? [],
    memory: {
      recentConversation: state.recentCompleteTurns ?? [],
      citedEvidence: (state.lastReferencedRecordIds ?? []).map((recordId) => ({ id: recordId })),
      pendingClarification: state.pendingClarification,
      collectedToolFields: state.collectedToolFields,
    },
  });
  const artifacts = preloadedArtifacts ?? dependencies.preloadedArtifacts ?? await (
    dependencies.loadArtifacts ?? loadPublishedEngineArtifacts
  )(auth, input, dependencies.artifacts);
  const route = classification(input, search);
  let channelPromise;
  const searchChannels = () => {
    channelPromise ??= (dependencies.searchCandidates ?? searchParallelHybridCandidates)({
      input,
      classification: route,
      resolution: null,
      publicationBundles: artifacts.bundles,
      sparseIndexes: artifacts.sparseIndexes,
      limitPerChannel: 20,
    }, dependencies.retrieval);
    return channelPromise;
  };
  const hybrid = await runTemplateEngineHybridRetrieval({
    decision: searchDecision,
    state,
    scope: { ...scope, publications: artifacts.publications },
    limitPerChannel: 20,
    candidateLimit: 20,
  }, {
    searchStructuredPostgres: async () => (await searchChannels()).channels.structured,
    searchBm25: async () => (await searchChannels()).channels.bm25,
    searchQdrantE5: async () => (await searchChannels()).channels.qdrant,
  });
  const retrieval = Object.freeze({
    ...hybrid,
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    recordTypes: Object.freeze([
      'CATALOG_ITEM', 'CATALOG_CATEGORY', 'FAQ', 'CONVERSATION_NODE',
      'WORKFLOW_RULE', 'KNOWLEDGE_CHUNK',
    ]),
  });
  const authoritative = await (dependencies.hydrateEvidence
    ?? rankAndHydrateAuthoritativeEvidence)({
    auth,
    input,
    classification: route,
    resolution: null,
    retrieval,
    limit: 5,
    minProviderScore: 0,
    requireAtLeastOneHydratedEvidence: true,
  }, dependencies.hydration);
  const hydratedEvidence = Array.isArray(authoritative.evidence)
    ? authoritative.evidence : [];
  const selectedCandidates = Array.isArray(authoritative?.fusion?.candidates)
    ? authoritative.fusion.candidates : retrieval.candidates;
  const evidence = verifyTemplateEngineEvidence(
    hydratedEvidence.map(evidenceRecord).slice(0, 5), selectedCandidates,
    { ...scope, publications: artifacts.publications },
  );
  if (selectedCandidates.length > 0 && evidence.length === 0) {
    throw new AppError(503,
      'Selected published records produced no verified template-engine evidence',
      'TEMPLATE_ENGINE_AUTHORITATIVE_EVIDENCE_EMPTY', {
        selectedCount: selectedCandidates.length,
        rejectedCount: Number(authoritative?.rejectedRecordIds?.length ?? 0),
      });
  }
  return Object.freeze({
    version: TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION,
    search,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    retrieval,
    evidence,
    diagnostics: Object.freeze({
      channelCounts: Object.freeze(Object.fromEntries(
        Object.entries(hybrid.channels).map(([channel, candidates]) => [
          channel, Array.isArray(candidates) ? candidates.length : 0,
        ]),
      )),
      retrievalCount: hybrid.candidates.length,
      hydrationCount: hydratedEvidence.length,
      verifiedEvidenceCount: evidence.length,
      failedChannels: Object.freeze(hybrid.failures.map((failure) => failure.channel)),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    }),
    authoritative,
    artifacts,
  });
}
