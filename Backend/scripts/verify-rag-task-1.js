import assert from 'node:assert/strict';
import { embedPassages, embedQuery } from '../src/rag/embedding.client.js';
import { embeddingModelSpec } from '../src/rag/model-spec.js';
import { collectionForTenant } from '../src/rag/qdrant.client.js';
import { tenantVectorPayload } from '../src/rag/tenant-isolation.js';

const tenantOne = '3a76a9bb-3206-4b86-b7f5-4960c834e1e6';
const tenantTwo = '1222ad4a-98db-4aa6-ae44-922489705e4b';
const knowledgeBaseId = '4f662796-6017-4e2a-8db8-21cba7927db3';
const documentId = '82b9c9c3-e88d-4d00-9f5a-98914cc2f1e6';
const documentVersionId = '0ede12b3-765c-475f-bacd-5b2787b34d37';

const tenantOneCollection = collectionForTenant(tenantOne);
const tenantTwoCollection = collectionForTenant(tenantTwo);
assert.notEqual(tenantOneCollection, tenantTwoCollection);
assert.match(tenantOneCollection, /^zea_voice_company_[a-f0-9_]+$/);
assert.throws(() => collectionForTenant('../shared'), /valid tenant UUID/);

const payload = tenantVectorPayload({
  tenantId: tenantOne,
  knowledgeBaseId,
  documentId,
  documentVersionId,
  recordId: documentId,
  recordType: 'knowledge_chunk',
  agentUsage: 'BOTH',
  category: 'general_knowledge',
  publicationRevision: 1,
  content: 'Hospital location and package information.',
  pageNumber: 2,
});
assert.equal(payload.tenant_id, tenantOne);
assert.equal(payload.knowledge_base_id, knowledgeBaseId);
assert.equal(payload.page_number, 2);
assert.throws(() => tenantVectorPayload({ ...payload, tenantId: tenantTwo, agentUsage: 'INVALID' }), /agentUsage/);

const originalFetch = globalThis.fetch;
let receivedAuthorization;
let receivedInputs;
globalThis.fetch = async (_url, options) => {
  receivedAuthorization = options.headers.authorization;
  const body = JSON.parse(options.body);
  receivedInputs = body.input;
  return new Response(JSON.stringify({
    object: 'list',
    model: embeddingModelSpec.id,
    data: body.input.map((_input, index) => ({
      object: 'embedding',
      index,
      embedding: Array.from({ length: embeddingModelSpec.dimensions }, (_value, vectorIndex) => vectorIndex === index ? 1 : 0),
    })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const queryVector = await embedQuery('Where is the hospital?');
  assert.equal(queryVector.length, 384);
  assert.match(receivedAuthorization, /^Bearer .{16,}$/);
  assert.deepEqual(receivedInputs, ['query: Where is the hospital?']);

  const passageVectors = await embedPassages(['Hospital location is Salem.', 'The Silver package costs 1650 rupees.']);
  assert.equal(passageVectors.length, 2);
  assert.deepEqual(receivedInputs, [
    'passage: Hospital location is Salem.',
    'passage: The Silver package costs 1650 rupees.',
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('RAG Task 1 verification passed: model contract, authentication, dimensions, prefixes, and tenant isolation.');
