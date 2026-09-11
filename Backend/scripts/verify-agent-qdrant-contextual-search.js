import assert from 'node:assert/strict';
import {
  contextualAgentDocumentSearchText,
  retrieveAgentQdrantKnowledge,
} from '../src/voice/interaction/agent-qdrant-retrieval.js';
import { createQdrantRetrievalRequest } from '../src/voice/interaction/qdrant-retrieval-contract.js';

const controller = new AbortController();
const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const request = createQdrantRetrievalRequest({
  tenantId,
  agentId,
  question: 'What is its price?',
  previousContext: [
    { role: 'user', content: 'Tell me about the Gold package.' },
    { role: 'assistant', content: 'The Gold package includes several health checks.' },
  ],
  cancellationSignal: controller.signal,
});

const contextual = contextualAgentDocumentSearchText(request);
assert.ok(contextual.startsWith('What is its price?'));
assert.match(contextual, /Gold package/u);

let embeddingCalls = 0;
let searchCalls = 0;
let embeddedText = '';
let searchOptions = null;
const result = await retrieveAgentQdrantKnowledge(request, {
  embedQuestion: async (contextualRequest) => {
    embeddingCalls += 1;
    embeddedText = contextualRequest.question;
    return { model: 'intfloat/multilingual-e5-base', vector: Array(768).fill(0.01) };
  },
  searchPoints: async (receivedTenantId, receivedAgentId, vector, options) => {
    searchCalls += 1;
    assert.equal(receivedTenantId, tenantId);
    assert.equal(receivedAgentId, agentId);
    assert.equal(vector.length, 768);
    searchOptions = options;
    return [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `point-${index}`,
        score: 0.99 - index * 0.1,
        payload: {
          tenant_id: tenantId,
          agent_id: agentId,
          document_id: '33333333-3333-4333-8333-333333333333',
          filename: 'packages.txt',
          chunk_id: `chunk-${index}`,
          chunk_index: index,
          chunk_text: `Gold package price is 4950. Chunk ${index}`,
          content_hash: `hash-${index}`,
          uploaded_at: '2026-09-10T12:00:00.000Z',
          source_kind: 'agent_text_document',
        },
      })),
      {
        id: 'foreign', score: 1,
        payload: {
          tenant_id: '99999999-9999-4999-8999-999999999999',
          agent_id: agentId,
          document_id: '44444444-4444-4444-8444-444444444444',
          filename: 'foreign.txt', chunk_index: 0, chunk_text: 'Private data',
          source_kind: 'agent_text_document',
        },
      },
    ];
  },
});

assert.equal(embeddingCalls, 1);
assert.equal(searchCalls, 1);
assert.match(embeddedText, /Gold package/u);
assert.equal(searchOptions.limit, 3);
assert.equal(searchOptions.abortSignal, controller.signal);
assert.equal(result.chunks.length, 3);
assert.deepEqual(result.chunks.map(({ id }) => id), ['point-0', 'point-1', 'point-2']);
assert.deepEqual(result.diagnostics, {
  channelCounts: { qdrant: 5 },
  retrievalCount: 5,
  hydrationCount: 3,
  verifiedEvidenceCount: 3,
  failedChannels: [],
  queryEmbeddingCount: 1,
  qdrantSearchCount: 1,
  returnedChunkCount: 3,
  maximumChunks: 3,
  tenantAgentFiltered: true,
});

console.log(JSON.stringify({
  retrieval: 'one-contextual-vector-search',
  queryEmbeddingCount: embeddingCalls,
  qdrantSearchCount: searchCalls,
  returnedChunks: result.chunks.length,
  tenantAgentFiltered: true,
}, null, 2));
