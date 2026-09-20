import assert from 'node:assert/strict';
import {
  assertQdrantRetrievalActive,
  createQdrantRetrievalRequest,
  createQdrantRetrievalResult,
  QDRANT_RETRIEVAL_LIMITS,
} from '../src/voice/interaction/qdrant-retrieval-contract.js';

const controller = new AbortController();
const request = createQdrantRetrievalRequest({
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  question: '  What is available?  ',
  previousContext: Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `Turn ${index}`,
  })),
  cancellationSignal: controller.signal,
});

assert.deepEqual(Object.keys(request), [
  'tenantId', 'agentId', 'question', 'previousContext', 'cancellationSignal',
]);
assert.equal(request.question, 'What is available?');
assert.equal(request.previousContext.length, QDRANT_RETRIEVAL_LIMITS.maximumPreviousTurns);

const points = [
  ...Array.from({ length: QDRANT_RETRIEVAL_LIMITS.maximumChunks + 2 }, (_, index) => ({
    id: `point-${index}`,
    score: 0.9 - index / 10,
    payload: {
      tenant_id: 'tenant-a', agent_id: 'agent-a', document_id: 'document-a',
      filename: 'knowledge.txt', chunk_id: `chunk-${index}`, chunk_index: index,
      chunk_text: `Verified chunk ${index}`, content_hash: `hash-${index}`,
      uploaded_at: '2026-09-10T00:00:00.000Z', source_kind: 'agent_text_document',
    },
  })),
  {
    id: 'cross-tenant', score: 1,
    payload: {
      tenant_id: 'tenant-b', agent_id: 'agent-a', document_id: 'document-b',
      filename: 'foreign.txt', chunk_index: 0, chunk_text: 'Must not cross the boundary',
      source_kind: 'agent_text_document',
    },
  },
];
const result = createQdrantRetrievalResult(request, points);
const wrongAgent = { ...points[0], id: 'cross-agent', score: 1,
  payload: { ...points[0].payload, agent_id: 'agent-b' } };
assert.deepEqual(createQdrantRetrievalResult(request, [wrongAgent]).chunks, []);
assert.deepEqual(Object.keys(result), ['chunks', 'liveDataCandidates']);
assert.equal(result.chunks.length, QDRANT_RETRIEVAL_LIMITS.maximumChunks);
assert.deepEqual(result.liveDataCandidates, []);
assert.ok(result.chunks.every((chunk) => chunk.verified === true));
assert.ok(result.chunks.every((chunk) => chunk.provenanceVerified === true
  && chunk.evidenceStatus === 'candidate' && chunk.answerSupportVerified === false));
assert.deepEqual(result.chunks.map((chunk) => chunk.id), Array.from(
  { length: QDRANT_RETRIEVAL_LIMITS.maximumChunks }, (_, index) => `point-${index}`,
));
assert.equal(result.chunks[0].source.filename, 'knowledge.txt');
assert.deepEqual(result.chunks[0].source.metadata, {
  chunkId: 'chunk-0', contentHash: 'hash-0', uploadedAt: '2026-09-10T00:00:00.000Z',
});

assert.throws(() => createQdrantRetrievalRequest({
  tenantId: 'tenant-a', agentId: 'agent-a', question: 'Question', cancellationSignal: null,
}), /AbortSignal/u);

controller.abort();
assert.throws(() => assertQdrantRetrievalActive(request), {
  name: 'AbortError', code: 'QDRANT_RETRIEVAL_CANCELLED',
});
assert.throws(() => createQdrantRetrievalResult(request, points), {
  name: 'AbortError', code: 'QDRANT_RETRIEVAL_CANCELLED',
});

console.log(JSON.stringify({
  contract: 'qdrant-retrieval',
  requestKeys: Object.keys(request),
  maximumPreviousTurns: QDRANT_RETRIEVAL_LIMITS.maximumPreviousTurns,
  maximumChunks: QDRANT_RETRIEVAL_LIMITS.maximumChunks,
  tenantIsolation: true,
  cancellation: true,
}, null, 2));
