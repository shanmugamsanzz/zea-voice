import { searchTenantAgentKnowledgeAndLiveDataPoints } from '../../rag/qdrant.client.js';
import { retrieveCurrentAgentLiveData } from '../../agents/agent-live-data-retrieval.service.js';
import { embeddingModelSpec } from '../../rag/model-spec.js';
import { embedAgentRetrievalQuestion } from './agent-document-embeddings.js';
import {
  assertQdrantRetrievalActive,
  createQdrantRetrievalRequest,
  createQdrantRetrievalResult,
  QDRANT_RETRIEVAL_LIMITS,
} from './qdrant-retrieval-contract.js';

const MAXIMUM_CONTEXT_TURNS = 2;
const MAXIMUM_CONTEXT_CHARACTERS = 320;
export const AGENT_QDRANT_RETRIEVAL_VERSION = 1;

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

/**
 * Builds one compact semantic query. Recent context helps pronouns and short
 * follow-ups, while the current question remains first and receives most of
 * the embedding input budget.
 */
export function contextualAgentDocumentSearchText(request) {
  const question = cleanText(request?.question, 2_000);
  let remaining = Math.min(MAXIMUM_CONTEXT_CHARACTERS, Math.max(80, question.length));
  const context = [];
  // Assistant-generated claims must not feed back into retrieval as search
  // anchors. Full delivered conversation remains available to the answer LLM.
  const callerTurns = (request?.previousContext ?? []).filter((turn) => turn.role === 'user');
  for (const turn of callerTurns.slice(-MAXIMUM_CONTEXT_TURNS).reverse()) {
    if (remaining <= 0) break;
    // Preserve the end of a caller fragment because it can correct its start.
    const content = cleanText(turn?.content).slice(-remaining);
    if (!content || content.toLocaleLowerCase() === question.toLocaleLowerCase()) continue;
    context.push(content);
    remaining -= content.length;
  }
  if (!context.length) return question;
  // Keep the explicit request at both boundaries of the single embedding input.
  return `${question}\nPrevious caller context: ${context.reverse().join('\n')}\nCurrent question: ${question}`;
}

function runtimeDependencies(overrides = {}) {
  return {
    embedQuestion: overrides.embedQuestion ?? embedAgentRetrievalQuestion,
    searchPoints: overrides.searchPoints ?? searchTenantAgentKnowledgeAndLiveDataPoints,
    retrieveLiveData: overrides.retrieveLiveData ?? retrieveCurrentAgentLiveData,
  };
}

function verifiedQueryEmbedding(value) {
  if (value?.model !== embeddingModelSpec.id
    || !Array.isArray(value?.vector)
    || value.vector.length !== embeddingModelSpec.dimensions
    || value.vector.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new TypeError(
      `Contextual retrieval requires one ${embeddingModelSpec.id} query embedding`,
    );
  }
  return value;
}

export async function retrieveAgentQdrantKnowledge(input = {}, overrides = {}) {
  const request = createQdrantRetrievalRequest(input);
  const dependencies = runtimeDependencies(overrides);
  assertQdrantRetrievalActive(request);
  const searchText = contextualAgentDocumentSearchText(request);
  const embedding = verifiedQueryEmbedding(await dependencies.embedQuestion(
    Object.freeze({ ...request, question: searchText }),
  ));
  assertQdrantRetrievalActive(request);
  const points = await dependencies.searchPoints(
    request.tenantId,
    request.agentId,
    embedding.vector,
    { limit: QDRANT_RETRIEVAL_LIMITS.maximumChunks,
      abortSignal: request.cancellationSignal },
  );
  const result = createQdrantRetrievalResult(request, points);
  const liveData = await dependencies.retrieveLiveData(
    request.tenantId, request.agentId, result.liveDataCandidates.map(({ tableId }) => tableId),
  );
  return Object.freeze({
    request,
    searchText,
    embeddingModel: embedding.model,
    chunks: result.chunks,
    liveData,
    diagnostics: Object.freeze({
      channelCounts: Object.freeze({ qdrant: points.length }),
      retrievalCount: points.length,
      verifiedEvidenceCount: result.chunks.length,
      candidateEvidenceCount: result.chunks.length,
      answerSupportVerified: false,
      failedChannels: Object.freeze([]),
      queryEmbeddingCount: 1,
      qdrantSearchCount: 1,
      returnedChunkCount: result.chunks.length,
      returnedLiveDataTableCount: liveData.length,
      maximumChunks: QDRANT_RETRIEVAL_LIMITS.maximumChunks,
      tenantAgentFiltered: true,
    }),
  });
}
