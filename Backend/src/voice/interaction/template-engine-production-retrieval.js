import { createKnowledgeEngineInput } from '../../knowledge-engine/engine-contract.js';
import { rankAndHydrateAuthoritativeEvidence } from '../../knowledge-engine/authoritative-evidence.js';
import { knowledgeSearchIndexes } from '../../knowledge-engine/query-classifier.js';
import { loadPublishedEngineArtifacts } from '../../knowledge-engine/runtime-service.js';
import { searchParallelHybridCandidates } from '../../knowledge-bases/parallel-hybrid-search.js';
import { runTemplateEngineHybridRetrieval } from './template-engine-hybrid-retrieval.js';

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
    sourceSection: provenance.sourceSection ?? source.sourceSection,
    sourceLine: provenance.sourceLineStart ?? source.sourceLineStart,
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
  return Object.freeze({
    artifacts,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    publishedWorkflows: Object.freeze(publishedWorkflows),
  });
}

export async function retrieveTemplateEngineEvidence({
  auth, scope, callId, usageDirection, language, searchDecision, state = {}, runtimeProfile,
  preloadedArtifacts = null,
} = {}, dependencies = {}) {
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
  }, dependencies.hydration);
  return Object.freeze({
    version: TEMPLATE_ENGINE_PRODUCTION_RETRIEVAL_VERSION,
    search,
    scope: Object.freeze({ ...scope, publications: artifacts.publications }),
    retrieval,
    evidence: Object.freeze(authoritative.evidence.map(evidenceRecord)
      .filter((source) => source.verified && source.callerFacing).slice(0, 5)),
    authoritative,
    artifacts,
  });
}
