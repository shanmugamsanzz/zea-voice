import assert from 'node:assert/strict';
import { createAgentTextDocumentBatch } from '../src/voice/interaction/agent-text-document-contract.js';
import { chunkAgentTextDocumentBatch } from '../src/voice/interaction/agent-text-document-chunker.js';
import {
  embedAgentDocumentChunks,
  embedAgentRetrievalQuestion,
} from '../src/voice/interaction/agent-document-embeddings.js';
import { createQdrantRetrievalRequest } from '../src/voice/interaction/qdrant-retrieval-contract.js';
import { embeddingModelSpec, prepareEmbeddingText } from '../src/rag/model-spec.js';

const documentBatch = createAgentTextDocumentBatch({
  tenantId: 'tenant-a', agentId: 'agent-a', files: [{
    originalname: 'multilingual.txt',
    buffer: Buffer.from(
      'English information is available. தமிழ் தகவலும் கிடைக்கிறது. हिंदी जानकारी भी उपलब्ध है. ' +
      'The same document can contain several languages and independent facts.',
    ),
  }],
}, { createDocumentId: () => 'document-a' });
const chunked = chunkAgentTextDocumentBatch(documentBatch, {
  chunkSizeTokens: 8, chunkOverlapTokens: 2, maximumChunkCharacters: 120,
});

const calls = [];
const fakeEmbedTexts = async (values, options) => {
  calls.push({
    inputs: values.map((value) => prepareEmbeddingText(value, options.kind)),
    kind: options.kind,
  });
  return values.map((_value, index) => Array.from(
    { length: embeddingModelSpec.dimensions }, (_unused, dimension) => dimension === index ? 1 : 0,
  ));
};

const embedded = await embedAgentDocumentChunks(chunked, {
  embeddingBatchSize: 2,
}, { embedTexts: fakeEmbedTexts });
assert.equal(embedded.model, 'intfloat/multilingual-e5-base');
assert.equal(embedded.dimensions, 768);
assert.equal(embedded.chunks.length, chunked.chunks.length);
assert.ok(embedded.chunks.every(({ embedding }) => embedding.length === 768));
assert.ok(calls.filter(({ kind }) => kind === 'passage')
  .flatMap(({ inputs }) => inputs).every((input) => input.startsWith('passage: ')));
assert.equal(calls.filter(({ kind }) => kind === 'passage')
  .flatMap(({ inputs }) => inputs).length, chunked.chunks.length);

const cancellation = new AbortController();
const request = createQdrantRetrievalRequest({
  tenantId: 'tenant-a', agentId: 'agent-a', question: 'தமிழ் தகவல் என்ன?',
  previousContext: [], cancellationSignal: cancellation.signal,
});
const query = await embedAgentRetrievalQuestion(request, { embedTexts: fakeEmbedTexts });
assert.equal(query.vector.length, 768);
assert.deepEqual(calls.at(-1), {
  inputs: ['query: தமிழ் தகவல் என்ன?'], kind: 'query',
});

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(() => embedAgentDocumentChunks(chunked, {
  embeddingBatchSize: 2, cancellationSignal: cancelled.signal,
}, { embedTexts: fakeEmbedTexts }), { name: 'AbortError', code: 'DOCUMENT_EMBEDDING_CANCELLED' });

await assert.rejects(() => embedAgentDocumentChunks(chunked, {
  embeddingBatchSize: 2,
}, { embedTexts: async (values) => values.slice(1).map(() => Array(768).fill(0)) }),
/unexpected passage vector count/u);

console.log(JSON.stringify({
  model: embedded.model,
  dimensions: embedded.dimensions,
  chunkCount: chunked.chunks.length,
  embeddingCount: embedded.chunks.length,
  passagePrefix: true,
  queryPrefix: true,
  multilingual: true,
}, null, 2));
