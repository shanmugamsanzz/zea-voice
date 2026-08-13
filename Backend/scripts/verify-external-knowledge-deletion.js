import assert from 'node:assert/strict';
import {
  deleteAllB2ObjectsUnderDocumentPrefix,
  knowledgeDocumentB2Prefix,
} from '../src/rag/b2.client.js';
import {
  collectionForTenant,
  deleteTenantPointsByDocument,
} from '../src/rag/qdrant.client.js';
import { processKnowledgeDeletionJob } from '../src/knowledge-bases/knowledge-deletion.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const knowledgeBaseId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const deletionJobId = '44444444-4444-4444-8444-444444444444';
const documentPrefix = knowledgeDocumentB2Prefix({ tenantId, knowledgeBaseId, documentId });

let b2ListPass = 0;
const b2Deletes = [];
const b2Cleanup = await deleteAllB2ObjectsUnderDocumentPrefix({
  prefix: documentPrefix, tenantId, knowledgeBaseId, documentId,
}, {
  bucket: 'private-test-bucket',
  timeoutMs: 5_000,
  client: {
    async send(command) {
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        b2ListPass += 1;
        assert.equal(command.input.Prefix, documentPrefix);
        if (b2ListPass > 1) return { IsTruncated: false, Versions: [], DeleteMarkers: [] };
        return {
          IsTruncated: false,
          Versions: [
            { Key: `${documentPrefix}versions/1/source.pdf`, VersionId: 'source-v1' },
            { Key: `${documentPrefix}versions/1/extracted-text.json`, VersionId: 'text-v1' },
            { Key: `${documentPrefix}orphaned.bin`, VersionId: 'orphan-v1' },
            { Key: `${documentPrefix.slice(0, -1)}-other/source.pdf`, VersionId: 'other-v1' },
          ],
          DeleteMarkers: [
            { Key: `${documentPrefix}versions/1/source.pdf`, VersionId: 'source-marker' },
          ],
        };
      }
      if (command.constructor.name === 'DeleteObjectCommand') {
        b2Deletes.push(command.input);
        return {};
      }
      throw new Error(`Unexpected B2 command ${command.constructor.name}`);
    },
  },
});
assert.equal(b2Cleanup.verified, true);
assert.equal(b2Cleanup.remainingObjectVersions, 0);
assert.equal(b2Cleanup.deletedVersionCount, 3);
assert.equal(b2Cleanup.deletedMarkerCount, 1);
assert.equal(b2Deletes.length, 4);
assert.equal(b2Deletes.some((entry) => entry.VersionId === 'other-v1'), false);

const originalFetch = globalThis.fetch;
const qdrantCalls = [];
let qdrantRemainingCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  qdrantCalls.push({ url: String(url), body });
  const payload = String(url).endsWith('/points/count')
    ? { result: { count: qdrantRemainingCount }, status: 'ok' }
    : { result: { status: 'completed' }, status: 'ok' };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  const qdrantCleanup = await deleteTenantPointsByDocument(tenantId, documentId, { knowledgeBaseId });
  assert.equal(qdrantCleanup.verified, true);
  assert.equal(qdrantCleanup.remainingCount, 0);
  const expectedFilter = {
    must: [
      { key: 'tenant_id', match: { value: tenantId } },
      { key: 'knowledge_base_id', match: { value: knowledgeBaseId } },
      { key: 'document_id', match: { value: documentId } },
    ],
  };
  assert.deepEqual(qdrantCalls[0].body.filter, expectedFilter);
  assert.deepEqual(qdrantCalls[1].body.filter, expectedFilter);
  assert.equal(qdrantCalls[1].body.exact, true);
  assert.equal(qdrantCalls.every((call) => call.url.includes(collectionForTenant(tenantId))), true);
  qdrantRemainingCount = 2;
  await assert.rejects(
    deleteTenantPointsByDocument(tenantId, documentId, { knowledgeBaseId }),
    (error) => error?.code === 'QDRANT_KNOWLEDGE_DELETE_INCOMPLETE'
      && error?.remainingCount === 2,
  );
} finally {
  globalThis.fetch = originalFetch;
}

const events = [];
const documentCascadeRows = [
  ['knowledge_document_versions', 'knowledge_documents'],
  ['knowledge_processing_jobs', 'knowledge_documents'],
  ['faq_entries', 'knowledge_document_versions'],
  ['structured_catalogs', 'knowledge_document_versions'],
  ['structured_items', 'structured_catalogs'],
  ['structured_item_attributes', 'structured_items'],
  ['workflow_rules', 'knowledge_document_versions'],
  ['conversation_flows', 'knowledge_document_versions'],
  ['knowledge_chunks', 'knowledge_document_versions'],
].map(([child_table, parent_table], index) => ({
  child_table, parent_table, constraint_name: `document_cascade_${index}`, delete_action: 'c',
}));
const documentVerificationRows = [
  'knowledge_documents', 'knowledge_document_versions', 'knowledge_processing_jobs',
  'faq_entries', 'structured_catalogs', 'structured_items', 'structured_item_attributes',
  'workflow_rules', 'conversation_flows', 'knowledge_chunks',
].map((table_name) => ({ table_name, remaining_count: 0 }));
const contextRunner = async (_auth, operation) => operation({
  async query(sql) {
    const text = String(sql).replace(/\s+/gu, ' ').trim();
    if (text.includes('FROM pg_constraint constraint_record')) {
      return { rowCount: documentCascadeRows.length, rows: documentCascadeRows };
    }
    if (text.includes(') document_cascade_verification')) {
      events.push({ type: 'postgres-zero-verification' });
      return { rowCount: documentVerificationRows.length, rows: documentVerificationRows };
    }
    if (text.startsWith('DELETE FROM knowledge_documents')) {
      events.push({ type: 'postgres-hard-delete' });
      return { rowCount: 1, rows: [{ id: documentId }] };
    }
    if (text.includes('SELECT * FROM knowledge_processing_jobs')) {
      return { rowCount: 1, rows: [{
        id: deletionJobId,
        tenant_id: tenantId,
        knowledge_base_id: knowledgeBaseId,
        document_id: documentId,
        job_type: 'delete_document',
        status: 'queued',
        attempt_count: 0,
        max_attempts: 10,
        metadata: {},
      }] };
    }
    if (text.includes('SELECT id, b2_object_key, extracted_text_object_key')) {
      return { rowCount: 1, rows: [{
        id: '55555555-5555-4555-8555-555555555555',
        b2_object_key: `${documentPrefix}versions/1/source.pdf`,
        extracted_text_object_key: `${documentPrefix}versions/1/extracted-text.json`,
      }] };
    }
    if (text.startsWith('SELECT id, bullmq_job_id')) {
      return { rowCount: 1, rows: [{ id: '66666666-6666-4666-8666-666666666666', bullmq_job_id: 'queue-related' }] };
    }
    return { rowCount: 1, rows: [] };
  },
});

const processed = await processKnowledgeDeletionJob(deletionJobId, {
  contextRunner,
  async removeQueueJobs(ids) {
    events.push({ type: 'bullmq', ids });
    return { removed: ids, active: [], missing: [], verified: true, remaining: [] };
  },
  async deleteDocumentPoints(foundTenantId, foundDocumentId, options) {
    events.push({ type: 'qdrant', foundTenantId, foundDocumentId, options });
    return { deleted: true, verified: true, remainingCount: 0 };
  },
  storage: {
    async deleteDocumentPrefix(input) {
      events.push({ type: 'b2', input });
      return { deleted: true, verified: true, remainingObjectVersions: 0 };
    },
  },
  async invalidateCache(foundTenantId) {
    events.push({ type: 'redis', foundTenantId });
    return { deletedKeys: 4, verified: true, remainingKeys: 0 };
  },
});

assert.equal(processed.status, 'completed');
assert.equal(processed.permanentlyDeleted, true);
assert.deepEqual(events.map((event) => event.type), [
  'bullmq', 'qdrant', 'b2', 'redis', 'postgres-hard-delete', 'postgres-zero-verification',
]);
assert.deepEqual(events[0].ids.sort(), [
  '66666666-6666-4666-8666-666666666666', 'queue-related',
]);
assert.deepEqual(events[1], {
  type: 'qdrant', foundTenantId: tenantId, foundDocumentId: documentId, options: { knowledgeBaseId },
});
assert.equal(events[2].input.prefix, documentPrefix);
assert.deepEqual(processed.verification, {
  postgresRows: 0,
  b2ObjectVersions: 0,
  qdrantPoints: 0,
  redisRagKeys: 0,
  bullmqJobs: 0,
});

console.log(JSON.stringify({
  task: 'External Knowledge document deletion',
  passed: true,
  exactScope: ['tenantId', 'knowledgeBaseId', 'documentId'],
  verifiedStores: ['BullMQ', 'Qdrant', 'Backblaze B2', 'Redis'],
  postgresHardDeleteVerified: true,
  postgresDependentRowsRemaining: 0,
}, null, 2));
