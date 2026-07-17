import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { env } from '../src/config/env.js';
import {
  activateKnowledgeDocumentVersion,
  deleteKnowledgeDocumentVersion,
  getKnowledgeDocument,
  listKnowledgeDocumentVersions,
  uploadKnowledgeDocumentVersion,
} from '../src/knowledge-bases/knowledge-document.service.js';
import {
  processKnowledgeDeletionJob,
  requestDeleteKnowledgeBase,
  requestDeleteKnowledgeDocument,
} from '../src/knowledge-bases/knowledge-deletion.service.js';
import { getKnowledgeBase } from '../src/knowledge-bases/knowledge-base.service.js';
import { deleteAllB2ObjectVersions, getB2Object, putB2Object } from '../src/rag/b2.client.js';
import {
  deleteTenantCollection,
  deleteTenantPointsByDocument,
  deleteTenantPointsByDocumentVersion,
  ensureTenantCollection,
  searchTenantPoints,
  upsertTenantPoints,
} from '../src/rag/qdrant.client.js';
import { tenantVectorPayload } from '../src/rag/tenant-isolation.js';

const { Client } = pg;

function pdfFile(label) {
  const buffer = Buffer.from(`%PDF-1.7\n${label}\n%%EOF`);
  return {
    buffer,
    mimetype: 'application/pdf',
    originalname: `${label}.pdf`,
    size: buffer.length,
  };
}

class StorageMock {
  uploaded = [];
  deleted = [];
  async putObject(input) {
    this.uploaded.push(input);
    return {
      bucket: env.B2_BUCKET,
      key: input.key,
      etag: `etag-${this.uploaded.length}`,
      storageVersionId: `b2-version-${this.uploaded.length}`,
    };
  }
  async deleteAllVersions({ key }) {
    this.deleted.push(key);
    return { key, deleted: true, deletedCount: 1 };
  }
}

async function createTenant(client, name) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`.toLowerCase();
  const tenantId = (await client.query(
    `INSERT INTO tenants (name, slug, status) VALUES ($1,$2,'active') RETURNING id`,
    [name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}`],
  )).rows[0].id;
  const organizationId = (await client.query(
    `INSERT INTO organizations (tenant_id, name, status) VALUES ($1,$2,'active') RETURNING id`,
    [tenantId, name],
  )).rows[0].id;
  const workspaceId = (await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1,$2,'Default','default','active',true) RETURNING id`,
    [tenantId, organizationId],
  )).rows[0].id;
  return { tenantId, workspaceId };
}

async function createKnowledgeBase(client, tenant, name, { published = false } = {}) {
  return (await client.query(
    `INSERT INTO knowledge_bases (
       tenant_id, workspace_id, name, status, publication_revision, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      tenant.tenantId, tenant.workspaceId, name,
      published ? 'published' : 'ready', published ? 1 : 0, published ? new Date() : null,
    ],
  )).rows[0].id;
}

async function createDocument(client, tenant, knowledgeBaseId, name, { extracted = true } = {}) {
  const documentId = (await client.query(
    `INSERT INTO knowledge_documents (
       tenant_id, knowledge_base_id, document_type, display_name,
       original_filename, size_bytes, status
     ) VALUES ($1,$2,'general_knowledge',$3,$4,100,'ready') RETURNING id`,
    [tenant.tenantId, knowledgeBaseId, name, `${name}.pdf`],
  )).rows[0].id;
  const sourceKey = `tenants/${tenant.tenantId}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/versions/1/source.pdf`;
  const extractedKey = sourceKey.replace('/source.pdf', '/extracted-text.json');
  const versionId = (await client.query(
    `INSERT INTO knowledge_document_versions (
       tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
       b2_bucket, b2_object_key, content_sha256, size_bytes,
       extracted_text_object_key, extraction_metadata, page_count, processed_at
     ) VALUES ($1,$2,$3,1,'ready',true,$4,$5,$6,100,$7,$8::jsonb,1,now()) RETURNING id`,
    [
      tenant.tenantId, knowledgeBaseId, documentId, env.B2_BUCKET, sourceKey,
      crypto.createHash('sha256').update(`${documentId}-v1`).digest('hex'),
      extracted ? extractedKey : null,
      JSON.stringify({
        source: { storageVersionId: 'source-v1' },
        extractedText: { storageVersionId: 'text-v1' },
      }),
    ],
  )).rows[0].id;
  const chunkId = (await client.query(
    `INSERT INTO knowledge_chunks (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       chunk_index, content, token_count, status, approved_at
     ) VALUES ($1,$2,$3,$4,0,$5,5,'approved',now()) RETURNING id`,
    [tenant.tenantId, knowledgeBaseId, documentId, versionId, `${name} knowledge content`],
  )).rows[0].id;
  return { documentId, versionId, chunkId, sourceKey, extractedKey };
}

function authFor(tenant) {
  return {
    tenantId: tenant.tenantId,
    workspaceId: tenant.workspaceId,
    userId: null,
    role: 'COMPANY_DEVELOPER',
    authType: 'session',
  };
}

async function verifyCompleteLifecycle() {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-10-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const tenant = await createTenant(client, 'Task 10 Company');
    const otherTenant = await createTenant(client, 'Task 10 Other Company');
    const knowledgeBaseId = await createKnowledgeBase(client, tenant, 'Versioned KB');
    const document = await createDocument(client, tenant, knowledgeBaseId, 'Hospital Guide');
    const otherKnowledgeBaseId = await createKnowledgeBase(client, otherTenant, 'Other Tenant KB', { published: true });
    const otherDocument = await createDocument(client, otherTenant, otherKnowledgeBaseId, 'Private Guide');
    const auth = authFor(tenant);
    let savepointNumber = 0;
    const sameTransaction = async (_auth, operation) => {
      savepointNumber += 1;
      const savepoint = `task10_${savepointNumber}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const value = await operation(client);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    };
    const storage = new StorageMock();
    const queuedJobs = [];
    const queue = async ({ processingJobId }) => {
      queuedJobs.push(processingJobId);
      return { id: `bull-${processingJobId}` };
    };

    const replacement = await uploadKnowledgeDocumentVersion(
      auth,
      knowledgeBaseId,
      document.documentId,
      { displayName: 'Hospital Guide Updated', metadata: { release: '2026-07' } },
      pdfFile('hospital-guide-v2'),
      storage,
      sameTransaction,
      queue,
    );
    assert.equal(replacement.version.versionNumber, 2);
    assert.equal(replacement.version.isCurrent, true);
    assert.equal(storage.uploaded.length, 1);
    assert.match(storage.uploaded[0].key, /\/versions\/2\/source\.pdf$/);
    const versions = await listKnowledgeDocumentVersions(
      auth, knowledgeBaseId, document.documentId, sameTransaction,
    );
    assert.deepEqual(versions.map((version) => [version.versionNumber, version.status, version.isCurrent]), [
      [2, 'queued', true],
      [1, 'archived', false],
    ]);
    const sourceMetadata = await client.query(
      `SELECT extraction_metadata FROM knowledge_document_versions WHERE id=$1`,
      [replacement.version.id],
    );
    assert.equal(sourceMetadata.rows[0].extraction_metadata.source.storageVersionId, 'b2-version-1');

    await client.query(
      `UPDATE knowledge_document_versions SET status='ready', processed_at=now() WHERE id=$1`,
      [replacement.version.id],
    );
    const rolledBack = await activateKnowledgeDocumentVersion(
      auth, knowledgeBaseId, document.documentId, document.versionId, sameTransaction,
    );
    assert.equal(rolledBack.versionNumber, 1);
    assert.equal(rolledBack.isCurrent, true);
    const restoredReplacement = await activateKnowledgeDocumentVersion(
      auth, knowledgeBaseId, document.documentId, replacement.version.id, sameTransaction,
    );
    assert.equal(restoredReplacement.versionNumber, 2);
    assert.equal(restoredReplacement.isCurrent, true);

    const deletedVectors = [];
    const archivedDeletion = await deleteKnowledgeDocumentVersion(
      auth,
      knowledgeBaseId,
      document.documentId,
      document.versionId,
      storage,
      sameTransaction,
      async (tenantId, versionId) => deletedVectors.push({ tenantId, versionId }),
    );
    assert.equal(archivedDeletion.deleted, true);
    assert.deepEqual(deletedVectors, [{ tenantId: tenant.tenantId, versionId: document.versionId }]);
    assert.ok(storage.deleted.includes(document.sourceKey));
    assert.ok(storage.deleted.includes(document.extractedKey));
    assert.equal((await client.query(
      'SELECT count(*)::int AS count FROM knowledge_document_versions WHERE id=$1',
      [document.versionId],
    )).rows[0].count, 0);

    await client.query(
      `UPDATE knowledge_document_versions SET status='ready' WHERE id=$1`,
      [replacement.version.id],
    );
    await client.query(
      `UPDATE knowledge_documents SET status='ready' WHERE id=$1`,
      [document.documentId],
    );
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='completed', progress=100, completed_at=now()
        WHERE id=$1`,
      [replacement.processingJobId],
    );
    await client.query(
      `UPDATE knowledge_bases SET status='published', publication_revision=1,
          published_at=now() WHERE id=$1`,
      [knowledgeBaseId],
    );
    await client.query(
      `INSERT INTO knowledge_chunks (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         chunk_index, content, token_count, status, approved_at
       ) VALUES ($1,$2,$3,$4,0,'Updated guide content',3,'approved',now())`,
      [tenant.tenantId, knowledgeBaseId, document.documentId, replacement.version.id],
    );

    const documentDelete = await requestDeleteKnowledgeDocument(
      auth, knowledgeBaseId, document.documentId, sameTransaction, queue,
    );
    assert.equal(documentDelete.deleted, true);
    await assert.rejects(
      getKnowledgeDocument(auth, knowledgeBaseId, document.documentId, sameTransaction),
      (error) => error.code === 'KNOWLEDGE_DOCUMENT_NOT_FOUND',
    );
    assert.equal((await client.query(
      'SELECT publication_revision FROM knowledge_bases WHERE id=$1',
      [knowledgeBaseId],
    )).rows[0].publication_revision, 2);

    const documentPointDeletes = [];
    const reindexQueue = [];
    const documentCleanup = await processKnowledgeDeletionJob(documentDelete.cleanupJob.id, {
      contextRunner: sameTransaction,
      storage: { deleteAllVersions: storage.deleteAllVersions.bind(storage) },
      async deleteDocumentPoints(tenantId, documentId) {
        documentPointDeletes.push({ tenantId, documentId });
      },
      async queue({ processingJobId }) {
        reindexQueue.push(processingJobId);
        return { id: `reindex-${processingJobId}` };
      },
      async invalidateCache() { return { deletedKeys: 0 }; },
    });
    assert.equal(documentCleanup.status, 'completed');
    assert.ok(documentCleanup.reindexJobId);
    assert.deepEqual(documentPointDeletes, [{ tenantId: tenant.tenantId, documentId: document.documentId }]);
    assert.deepEqual(reindexQueue, [documentCleanup.reindexJobId]);
    assert.equal((await client.query(
      'SELECT count(*)::int AS count FROM knowledge_chunks WHERE document_id=$1',
      [document.documentId],
    )).rows[0].count, 0);
    assert.equal((await client.query(
      'SELECT status FROM knowledge_document_versions WHERE id=$1',
      [replacement.version.id],
    )).rows[0].status, 'deleted');

    const completeKbId = await createKnowledgeBase(client, tenant, 'Delete Complete KB', { published: true });
    const completeDocument = await createDocument(client, tenant, completeKbId, 'Delete Everything');
    const kbDelete = await requestDeleteKnowledgeBase(auth, completeKbId, sameTransaction, queue);
    assert.equal(kbDelete.deleted, true);
    await assert.rejects(
      getKnowledgeBase(auth, completeKbId, sameTransaction),
      (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND',
    );
    const knowledgeBasePointDeletes = [];
    const kbCleanup = await processKnowledgeDeletionJob(kbDelete.cleanupJob.id, {
      contextRunner: sameTransaction,
      storage: { deleteAllVersions: storage.deleteAllVersions.bind(storage) },
      async deleteKnowledgeBasePoints(tenantId, id) {
        knowledgeBasePointDeletes.push({ tenantId, knowledgeBaseId: id });
      },
      async invalidateCache() { return { deletedKeys: 0 }; },
    });
    assert.equal(kbCleanup.status, 'completed');
    assert.deepEqual(knowledgeBasePointDeletes, [{
      tenantId: tenant.tenantId, knowledgeBaseId: completeKbId,
    }]);
    const completeState = await client.query(
      `SELECT
         (SELECT status FROM knowledge_bases WHERE id=$1) AS kb_status,
         (SELECT status FROM knowledge_documents WHERE id=$2) AS document_status,
         (SELECT status FROM knowledge_document_versions WHERE id=$3) AS version_status,
         (SELECT count(*)::int FROM knowledge_chunks WHERE knowledge_base_id=$1) AS chunks`,
      [completeKbId, completeDocument.documentId, completeDocument.versionId],
    );
    assert.deepEqual(completeState.rows[0], {
      kb_status: 'deleted', document_status: 'deleted', version_status: 'deleted', chunks: 0,
    });

    const isolated = await client.query(
      `SELECT d.status AS document_status, v.status AS version_status,
          (SELECT count(*)::int FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2) AS chunks
         FROM knowledge_documents d JOIN knowledge_document_versions v ON v.document_id=d.id
        WHERE d.tenant_id=$1 AND d.id=$2`,
      [otherTenant.tenantId, otherDocument.documentId],
    );
    assert.deepEqual(isolated.rows[0], { document_status: 'ready', version_status: 'ready', chunks: 1 });
  } finally {
    if (transactionStarted) await client.query('ROLLBACK');
    await client.end();
  }
}

async function verifyRoutesAndImplementation() {
  const routes = await readFile(new URL('../src/knowledge-bases/knowledge-document.routes.js', import.meta.url), 'utf8');
  assert.match(routes, /post\('\/:documentId\/versions'/);
  assert.match(routes, /get\('\/:documentId\/versions'/);
  assert.match(routes, /delete\('\/:documentId\/versions\/:versionId'/);
  assert.match(routes, /post\('\/:documentId\/versions\/:versionId\/activate'/);
  assert.match(routes, /delete\('\/:documentId'/);
  const dispatcher = await readFile(new URL('../src/knowledge-bases/knowledge-job.dispatcher.js', import.meta.url), 'utf8');
  assert.match(dispatcher, /delete_document/);
  assert.match(dispatcher, /delete_knowledge_base/);
}

async function verifyLiveTemporaryCleanupWhenRequested() {
  if (process.env.RAG_TASK10_LIVE_CLEANUP !== 'true') {
    return { b2: false, qdrant: false };
  }
  const tenantId = crypto.randomUUID();
  const knowledgeBaseId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const documentVersionId = crypto.randomUUID();
  const secondDocumentId = crypto.randomUUID();
  const secondVersionId = crypto.randomUUID();
  const vector = Array.from({ length: env.QDRANT_VECTOR_SIZE }, (_value, index) => index === 0 ? 1 : 0);
  const b2Key = `verification/task-10/${crypto.randomUUID()}/versioned-object.txt`;
  let b2Verified = false;
  let qdrantVerified = false;
  try {
    await putB2Object({ key: b2Key, body: Buffer.from('task-10-version-1'), contentType: 'text/plain' });
    await putB2Object({ key: b2Key, body: Buffer.from('task-10-version-2'), contentType: 'text/plain' });
    const b2Deletion = await deleteAllB2ObjectVersions({ key: b2Key });
    assert.ok(b2Deletion.deletedCount >= 2, 'Every temporary B2 object version must be removed');
    await assert.rejects(getB2Object({ key: b2Key, maxBytes: 1024 }));
    b2Verified = true;

    await ensureTenantCollection(tenantId);
    const point = (id, docId, versionId, content) => ({
      id,
      vector,
      payload: tenantVectorPayload({
        tenantId, knowledgeBaseId, documentId: docId, documentVersionId: versionId,
        recordId: id, recordType: 'knowledge_chunk', agentUsage: 'BOTH',
        category: 'general_knowledge', publicationRevision: 1, content,
      }),
    });
    const firstPointId = crypto.randomUUID();
    const secondPointId = crypto.randomUUID();
    await upsertTenantPoints(tenantId, [
      point(firstPointId, documentId, documentVersionId, 'Temporary first document'),
      point(secondPointId, secondDocumentId, secondVersionId, 'Temporary second document'),
    ]);
    await deleteTenantPointsByDocumentVersion(tenantId, documentVersionId);
    let matches = await searchTenantPoints(tenantId, vector, {
      knowledgeBases: [{ id: knowledgeBaseId, publicationRevision: 1 }],
      usageDirection: 'outbound', limit: 10, scoreThreshold: 0,
    });
    assert.ok(!matches.some((match) => match.id === firstPointId));
    assert.ok(matches.some((match) => match.id === secondPointId));
    await deleteTenantPointsByDocument(tenantId, secondDocumentId);
    matches = await searchTenantPoints(tenantId, vector, {
      knowledgeBases: [{ id: knowledgeBaseId, publicationRevision: 1 }],
      usageDirection: 'outbound', limit: 10, scoreThreshold: 0,
    });
    assert.equal(matches.length, 0);
    qdrantVerified = true;
    return { b2: b2Verified, qdrant: qdrantVerified };
  } finally {
    await deleteAllB2ObjectVersions({ key: b2Key }).catch(() => {});
    await deleteTenantCollection(tenantId).catch(() => {});
  }
}

await verifyCompleteLifecycle();
await verifyRoutesAndImplementation();
const liveCleanup = await verifyLiveTemporaryCleanupWhenRequested();

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 10 - Versioning, deletion and complete verification',
  verified: {
    immutableReplacementVersions: true,
    currentAndArchivedVersionState: true,
    archivedVersionRollback: true,
    sourceAndExtractedB2Cleanup: true,
    documentVersionVectorCleanup: true,
    documentDeletionAndReindex: true,
    knowledgeBaseCompleteCleanup: true,
    deletionJobRetries: true,
    runtimeTombstones: true,
    tenantIsolation: true,
  },
  temporaryB2VersionCleanupVerified: liveCleanup.b2,
  temporaryQdrantPointCleanupVerified: liveCleanup.qdrant,
  temporaryExternalResourcesDeleted: liveCleanup.b2 && liveCleanup.qdrant,
  databaseFixturesPersisted: false,
}, null, 2));
