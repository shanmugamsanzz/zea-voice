import { searchTenantAgentDocumentPoints } from '../../rag/qdrant.client.js';
import { embeddingModelSpec } from '../../rag/model-spec.js';
import { embedAgentRetrievalQuestion } from './agent-document-embeddings.js';
import {
  assertQdrantRetrievalActive,
  createQdrantRetrievalRequest,
  createQdrantRetrievalResult,
} from './qdrant-retrieval-contract.js';

const MAXIMUM_CONTEXT_TURNS = 4;
const MAXIMUM_CONTEXT_CHARACTERS = 1_200;
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
  let remaining = MAXIMUM_CONTEXT_CHARACTERS;
  const context = [];
  for (const turn of (request?.previousContext ?? []).slice(-MAXIMUM_CONTEXT_TURNS).reverse()) {
    if (remaining <= 0) break;
    const content = cleanText(turn?.content, Math.min(400, remaining));
    if (!content || content.toLocaleLowerCase() === question.toLocaleLowerCase()) continue;
    const role = turn?.role === 'assistant' ? 'Assistant' : 'Caller';
    context.push(`${role}: ${content}`);
    remaining -= content.length;
  }
  return [question, ...context.reverse()].join('\nContext: ');
}

function runtimeDependencies(overrides = {}) {
  return {
    embedQuestion: overrides.embedQuestion ?? embedAgentRetrievalQuestion,
    searchPoints: overrides.searchPoints ?? searchTenantAgentDocumentPoints,
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
    { limit: 3, abortSignal: request.cancellationSignal },
  );
  const result = createQdrantRetrievalResult(request, points);
  return Object.freeze({
    request,
    searchText,
    embeddingModel: embedding.model,
    chunks: result.chunks,
    diagnostics: Object.freeze({
      channelCounts: Object.freeze({ qdrant: points.length }),
      retrievalCount: points.length,
      hydrationCount: result.chunks.length,
      verifiedEvidenceCount: result.chunks.length,
      failedChannels: Object.freeze([]),
      queryEmbeddingCount: 1,
      qdrantSearchCount: 1,
      returnedChunkCount: result.chunks.length,
      maximumChunks: 3,
      tenantAgentFiltered: true,
    }),
  });
}
