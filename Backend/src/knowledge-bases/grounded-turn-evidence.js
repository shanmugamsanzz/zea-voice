import {
  rankAndHydrateAuthoritativeEvidence,
} from '../knowledge-engine/authoritative-evidence.js';
import { searchParallelHybridCandidates } from './parallel-hybrid-search.js';

export const GROUNDED_TURN_EVIDENCE_VERSION = 1;
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

function relevantHydratedEvidence(sources, classification = {}, resolution = {}, input = {}) {
  const intentClass = String(classification.intentClass ?? '').trim().toUpperCase();
  const namespace = String(resolution.candidateNamespace ?? '').trim().toUpperCase();
  const selectedTypes = namespaceRecordTypes[namespace]
    ?? (catalogIntentClasses.has(intentClass) ? namespaceRecordTypes.CATALOG : null);
  const rememberedTool = input?.memory?.activeTool ?? input?.canonicalCallMemory?.activeTool;
  const actionTurn = intentClass === 'ACTION_TOOL_REQUEST'
    || (!namespace && Boolean(rememberedTool));
  const protocolTurn = ['SAFETY_EMERGENCY', 'CALL_CONTROL'].includes(intentClass);
  const selectedRecordIds = new Set([
    resolution?.candidate?.recordId,
    ...(resolution?.candidate?.evidenceRecordIds ?? []),
    ...(resolution?.routingCandidates ?? []).filter((candidate) => candidate.explicit === true)
      .map((candidate) => candidate.recordId),
  ].map(identity).filter(Boolean));
  return sources.filter((source) => {
    const recordType = String(source.recordType ?? '').toUpperCase();
    if (selectedRecordIds.has(identity(source.recordId))) return true;
    if (recordType === 'WORKFLOW_RULE') return actionTurn || protocolTurn;
    if (selectedTypes) return selectedTypes.has(recordType);
    if (intentClass === 'ACKNOWLEDGEMENT') {
      return ['CONVERSATION_NODE', 'FAQ'].includes(recordType);
    }
    // With no resolved namespace, retain caller-facing discovery evidence.
    // Internal Workflow records are admitted only by the action/protocol rule
    // above, so unrelated authorization cannot influence a normal answer.
    return source.callerFacing === true;
  });
}

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return clean(value, 240).toLocaleLowerCase();
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

function compactMemory(input = {}) {
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  return Object.freeze({
    activeEntity: memory.activeEntity ?? null,
    activeCategory: memory.activeCategory ?? null,
    requestedFact: input.requestedFact ?? memory.requestedFact ?? null,
    recentTurns: Object.freeze([...(input.recentRelevantTurns
      ?? memory.recentConversation ?? memory.recentTurns ?? [])].slice(-4)),
    pendingClarification: memory.pendingClarification ?? null,
    activeTool: memory.activeTool ?? null,
    collectedToolFields: Object.freeze({ ...(memory.collectedToolFields ?? {}) }),
  });
}

function compactEvidence(source, sourceId) {
  const provenance = source.provenance ?? {};
  return Object.freeze({
    sourceId,
    publishedEvidenceId: source.id,
    recordId: source.recordId,
    recordType: source.recordType,
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
    allHydrated, classification, resolution, input,
  ).slice(0, maximumEvidenceRecords);
  if (hydrated.length > maximumEvidenceRecords) {
    throw new TypeError('Grounded LLM input cannot contain more than five hydrated records');
  }
  const evidence = Object.freeze(hydrated.map((source, index) => (
    compactEvidence(source, `source_${index + 1}`)
  )));
  const sourceMap = Object.freeze(evidence.map((source) => Object.freeze({
    sourceId: source.sourceId,
    publishedEvidenceId: source.publishedEvidenceId,
    recordId: source.recordId,
    recordType: source.recordType,
    ...source.provenance,
  })));
  const workflowAuthorization = applicableTools(hydrated, runtimeProfile);
  const workflowIds = new Set(workflowAuthorization.map((entry) => entry.workflowEvidenceId));
  const responseSourceIds = evidence.filter((source) => source.callerFacing)
    .map((source) => source.sourceId);
  const toolSourceIds = evidence.filter((source) => workflowIds.has(source.publishedEvidenceId))
    .map((source) => source.sourceId);
  return Object.freeze({
    contractVersion: GROUNDED_TURN_EVIDENCE_VERSION,
    currentQuestion: clean(input?.latestQuestion ?? input?.utterance, 2_000),
    memory: compactMemory(input),
    evidence,
    workflowAuthorization,
    assignedToolSchemas: Object.freeze(workflowAuthorization.map((entry) => Object.freeze({
      name: entry.toolName,
      authorizationEvidenceId: entry.workflowEvidenceId,
      inputSchema: entry.inputSchema,
    }))),
    permittedSourceIds: Object.freeze({
      response: Object.freeze(responseSourceIds),
      tool: Object.freeze(toolSourceIds),
    }),
    sourceMap,
  });
}

export async function retrieveRankHydrateGroundedTurn({
  auth, input, classification, resolution, publicationBundles,
  sparseIndexes = [], runtimeProfile,
} = {}, dependencies = {}) {
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
    minProviderScore: dependencies.minProviderScore ?? 0.68,
  }, dependencies.hydration);
  const hydrationMs = Math.max(0, performance.now() - hydrationStartedAt);
  if (authoritative.fusion.candidates.length > maximumEvidenceRecords
    || authoritative.evidence.length > maximumEvidenceRecords) {
    throw new TypeError('Grounded turn exceeded the five-record authoritative limit');
  }
  if (authoritative.hydrationQueryCount > 1) {
    throw new TypeError('Grounded turn performed more than one PostgreSQL hydration query');
  }
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
