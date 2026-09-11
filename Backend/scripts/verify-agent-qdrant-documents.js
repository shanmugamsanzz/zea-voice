import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  deleteAgentQdrantDocument,
  listAgentQdrantDocuments,
  qdrantAgentDocumentPoint,
  replaceAgentQdrantDocument,
  uploadAgentQdrantDocuments,
} from '../src/agents/agent-qdrant-document.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const oldDocumentId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-09-10T12:00:00.000Z');
const auth = { tenantId, workspaceId: '44444444-4444-4444-8444-444444444444' };
const vector = Object.freeze(Array.from({ length: 768 }, () => 0.01));
const upserted = [];
const deleted = [];
let agentReads = 0;

const common = {
  ensureAgent: async () => { agentReads += 1; },
  ensureCollection: async () => ({ collectionName: 'tenant-test', created: false }),
  embedChunks: async (batch) => ({
    ...batch,
    chunks: batch.chunks.map((chunk) => ({ ...chunk, embedding: vector })),
  }),
  upsertPoints: async (_tenantId, points) => {
    upserted.push(...points);
    return { count: points.length };
  },
  deletePoints: async (_tenantId, _agentId, documentId) => {
    deleted.push(documentId);
    return { deleted: true, verified: true, remainingCount: 0 };
  },
  now: () => now,
};

const uploaded = await uploadAgentQdrantDocuments(auth, agentId, [
  { originalname: 'hospital.txt', mimetype: 'text/plain', buffer: Buffer.from('Hospital address and opening hours. '.repeat(80)) },
  { originalname: 'packages.txt', mimetype: 'text/plain', buffer: Buffer.from('Silver, Gold and Platinum package information. '.repeat(80)) },
], common);

assert.equal(uploaded.documents.length, 2);
assert.ok(upserted.length >= 2);
assert.ok(upserted.every(({ vector: embeddedVector }) => embeddedVector.length === 768));
assert.ok(upserted.every(({ payload }) => (
  payload.tenant_id === tenantId
  && payload.agent_id === agentId
  && payload.document_id
  && payload.filename.endsWith('.txt')
  && payload.chunk_id
  && Number.isInteger(payload.chunk_index)
  && payload.chunk_text
  && payload.content_hash
  && payload.uploaded_at === now.toISOString()
  && payload.source_kind === 'agent_text_document'
)));
assert.equal('knowledge_base_id' in upserted[0].payload, false);

const listed = await listAgentQdrantDocuments(auth, agentId, {
  ...common,
  scrollPoints: async () => upserted.map(({ id, payload }) => ({ id, payload })),
});
assert.equal(listed.length, 2);
assert.equal(listed.reduce((sum, document) => sum + document.chunkCount, 0), upserted.length);

const oldPoint = qdrantAgentDocumentPoint(tenantId, agentId, {
  id: oldDocumentId,
  filename: 'old.txt',
  byteLength: 3,
  checksumSha256: 'old-hash',
}, {
  id: `${oldDocumentId}:0`,
  documentId: oldDocumentId,
  chunkIndex: 0,
  characterStart: 0,
  characterEnd: 3,
  tokenCount: 1,
  overlapTokenCount: 0,
  text: 'old',
  contentHash: 'old-chunk-hash',
  embedding: vector,
}, now.toISOString());

const replaced = await replaceAgentQdrantDocument(auth, agentId, oldDocumentId, {
  originalname: 'replacement.txt', mimetype: 'text/plain', buffer: Buffer.from('Replacement information.'),
}, {
  ...common,
  scrollPoints: async (_tenantId, _agentId, options) => (
    options?.documentId === oldDocumentId ? [oldPoint] : []
  ),
});
assert.equal(replaced.replacedDocumentId, oldDocumentId);
assert.ok(deleted.includes(oldDocumentId));

await deleteAgentQdrantDocument(auth, agentId, oldDocumentId, {
  ...common,
  scrollPoints: async () => [oldPoint],
});
assert.equal(deleted.filter((id) => id === oldDocumentId).length, 2);
assert.ok(agentReads >= 4, 'Agent existence remains a PostgreSQL read-only boundary');

const [serviceSource, resourceServiceSource, routeSource] = await Promise.all([
  readFile(new URL('../src/agents/agent-qdrant-document.service.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/agents/agent-resource.service.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/agents/agent-qdrant-document.routes.js', import.meta.url), 'utf8'),
]);
assert.doesNotMatch(serviceSource, /database-context|\.query\(|agent_knowledge_documents/u);
assert.doesNotMatch(resourceServiceSource, /agent_knowledge_documents/u);
assert.match(routeSource, /\.get\('\/'/u);
assert.match(routeSource, /\.post\('\/'/u);
assert.match(routeSource, /\.put\('\/:documentId'/u);
assert.match(routeSource, /\.delete\('\/:documentId'/u);

console.log(JSON.stringify({
  subsystem: 'agent-qdrant-documents',
  documentsUploaded: uploaded.documents.length,
  chunksStored: upserted.length,
  qdrantMetadataComplete: true,
  postgresDocumentWrites: 0,
  listReplaceDeleteVerified: true,
}, null, 2));
