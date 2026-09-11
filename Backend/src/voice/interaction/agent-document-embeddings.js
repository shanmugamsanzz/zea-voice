import { embedTexts } from '../../rag/embedding.client.js';
import { embeddingModelSpec } from '../../rag/model-spec.js';
import { assertQdrantRetrievalActive } from './qdrant-retrieval-contract.js';

function batchSize(value) {
  const size = Number(value ?? 16);
  if (!Number.isInteger(size) || size < 1 || size > 128) {
    throw new TypeError('embeddingBatchSize must be an integer between 1 and 128');
  }
  return size;
}

function assertSignalActive(signal) {
  if (signal?.aborted !== true) return;
  const error = new Error('Document embedding was cancelled');
  error.name = 'AbortError';
  error.code = 'DOCUMENT_EMBEDDING_CANCELLED';
  throw error;
}

function verifiedVector(value) {
  if (!Array.isArray(value) || value.length !== embeddingModelSpec.dimensions
    || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error(`Embedding provider must return one numeric ${embeddingModelSpec.dimensions}-dimension vector per input`);
  }
  return Object.freeze([...value]);
}

/**
 * Generates exactly one multilingual E5 passage embedding for every chunk.
 * Batching changes only the number of HTTP requests, never the chunk-to-vector
 * cardinality or ordering.
 */
export async function embedAgentDocumentChunks(chunkedBatch, options = {}, dependencies = {}) {
  if (!chunkedBatch?.tenantId || !chunkedBatch?.agentId
    || !Array.isArray(chunkedBatch.chunks) || !chunkedBatch.chunks.length) {
    throw new TypeError('A non-empty chunked agent document batch is required');
  }
  const invoke = dependencies.embedTexts ?? embedTexts;
  const size = batchSize(options.embeddingBatchSize);
  const signal = options.cancellationSignal;
  const embedded = [];
  for (let offset = 0; offset < chunkedBatch.chunks.length; offset += size) {
    assertSignalActive(signal);
    const sourceChunks = chunkedBatch.chunks.slice(offset, offset + size);
    const vectors = await invoke(sourceChunks.map(({ text }) => text), {
      kind: 'passage', signal,
    });
    if (!Array.isArray(vectors) || vectors.length !== sourceChunks.length) {
      throw new Error('Embedding provider returned an unexpected passage vector count');
    }
    for (let index = 0; index < sourceChunks.length; index += 1) {
      embedded.push(Object.freeze({
        ...sourceChunks[index],
        embedding: verifiedVector(vectors[index]),
      }));
    }
  }
  assertSignalActive(signal);
  if (embedded.length !== chunkedBatch.chunks.length) {
    throw new Error('Every document chunk must have exactly one embedding');
  }
  return Object.freeze({
    tenantId: chunkedBatch.tenantId,
    agentId: chunkedBatch.agentId,
    model: embeddingModelSpec.id,
    dimensions: embeddingModelSpec.dimensions,
    documents: chunkedBatch.documents,
    chunks: Object.freeze(embedded),
  });
}

/** Generate the matching E5 query-space vector for the retrieval boundary. */
export async function embedAgentRetrievalQuestion(request, dependencies = {}) {
  assertQdrantRetrievalActive(request);
  const invoke = dependencies.embedTexts ?? embedTexts;
  const vectors = await invoke([request.question], {
    kind: 'query', signal: request.cancellationSignal,
  });
  assertQdrantRetrievalActive(request);
  if (!Array.isArray(vectors) || vectors.length !== 1) {
    throw new Error('Embedding provider must return exactly one query vector');
  }
  return Object.freeze({
    model: embeddingModelSpec.id,
    dimensions: embeddingModelSpec.dimensions,
    vector: verifiedVector(vectors[0]),
  });
}
