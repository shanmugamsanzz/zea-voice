import assert from 'node:assert/strict';
import pg from 'pg';
import { requireRoles } from '../src/auth/auth.middleware.js';
import { env } from '../src/config/env.js';
import { knowledgeDocumentRouter } from '../src/knowledge-bases/knowledge-document.routes.js';
import {
  KNOWLEDGE_DOCUMENT_TYPES,
  parseKnowledgeDocumentInput,
  uploadKnowledgeDocumentSchema,
} from '../src/knowledge-bases/knowledge-document.schemas.js';
import {
  getKnowledgeDocument,
  knowledgeDocumentObjectKey,
  listKnowledgeDocuments,
  uploadKnowledgeDocument,
  validatePdfFile,
} from '../src/knowledge-bases/knowledge-document.service.js';

const { Client } = pg;

function verifyValidationAndRouting() {
  assert.deepEqual(KNOWLEDGE_DOCUMENT_TYPES, [
    'faq', 'catalog', 'workflow_rules', 'conversation_script', 'general_knowledge',
  ]);
  for (const documentType of KNOWLEDGE_DOCUMENT_TYPES) {
    const parsed = parseKnowledgeDocumentInput(uploadKnowledgeDocumentSchema, {
      documentType,
      metadata: JSON.stringify({ source: 'verification' }),
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.metadata, { source: 'verification' });
  }
  assert.equal(parseKnowledgeDocumentInput(uploadKnowledgeDocumentSchema, {
    documentType: 'auto_detect',
  }).success, false);

  const validFile = {
    originalname: 'hospital.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    size: 14,
  };
  validatePdfFile(validFile);
  assert.throws(() => validatePdfFile({ ...validFile, mimetype: 'image/png' }), /Only application\/pdf/);
  assert.throws(() => validatePdfFile({ ...validFile, buffer: Buffer.from('not-a-pdf-file') }), /valid PDF signature/);

  const tenantA = '3a76a9bb-3206-4b86-b7f5-4960c834e1e6';
  const tenantB = '1222ad4a-98db-4aa6-ae44-922489705e4b';
  const knowledgeBaseId = '4f662796-6017-4e2a-8db8-21cba7927db3';
  const documentId = '82b9c9c3-e88d-4d00-9f5a-98914cc2f1e6';
  const keyA = knowledgeDocumentObjectKey({ tenantId: tenantA, knowledgeBaseId, documentId, versionNumber: 1 });
  const keyB = knowledgeDocumentObjectKey({ tenantId: tenantB, knowledgeBaseId, documentId, versionNumber: 1 });
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.startsWith(`tenants/${tenantA}/knowledge-bases/${knowledgeBaseId}/`));
  assert.throws(() => knowledgeDocumentObjectKey({
    tenantId: '../shared', knowledgeBaseId, documentId, versionNumber: 1,
  }), /tenantId must be a UUID/);

  let permissionError;
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER')(
    { auth: { role: 'COMPANY_USER' } }, {}, (error) => { permissionError = error; },
  );
  assert.equal(permissionError.statusCode, 403);

  const routes = knowledgeDocumentRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  for (const requiredRoute of ['GET /', 'GET /:documentId', 'POST /']) {
    assert.ok(routes.includes(requiredRoute), `Missing Task 4 route: ${requiredRoute}`);
  }
  return validFile;
}

async function insertTenant(client, label) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenant = await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [`RAG upload verification ${label}`, `rag-upload-verification-${label}-${suffix}`],
  );
  const organization = await client.query(
    `INSERT INTO organizations (tenant_id, name, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [tenant.rows[0].id, `RAG upload verification ${label}`],
  );
  const workspace = await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1, $2, 'Default', 'default', 'active', true) RETURNING id`,
    [tenant.rows[0].id, organization.rows[0].id],
  );
  const knowledgeBase = await client.query(
    `INSERT INTO knowledge_bases (tenant_id, workspace_id, name)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenant.rows[0].id, workspace.rows[0].id, `Hospital KB ${label}`],
  );
  return {
    tenantId: tenant.rows[0].id,
    workspaceId: workspace.rows[0].id,
    knowledgeBaseId: knowledgeBase.rows[0].id,
  };
}

async function verifyLivePersistence(validFile) {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-4-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const tenantA = await insertTenant(client, 'a');
    const tenantB = await insertTenant(client, 'b');

    await client.query('SET LOCAL ROLE zea_voice_runtime');
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA.tenantId]);

    const authA = {
      authType: 'session',
      role: 'COMPANY_DEVELOPER',
      userId: null,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
    };
    const sameTransaction = (_auth, operation) => operation(client);
    const uploadedObjects = [];
    const deletedObjects = [];
    const mockStorage = {
      async putObject(input) {
        uploadedObjects.push(input);
        return { bucket: 'zea-voice', key: input.key, etag: 'test-etag', storageVersionId: 'test-version' };
      },
      async deleteObject(input) {
        deletedObjects.push(input);
        return { ...input, deleted: true };
      },
    };
    const mockQueue = async ({ processingJobId }) => ({ id: processingJobId });

    const uploaded = await uploadKnowledgeDocument(
      authA,
      tenantA.knowledgeBaseId,
      { documentType: 'faq', displayName: 'Hospital FAQ', metadata: { language: 'en' } },
      validFile,
      mockStorage,
      sameTransaction,
      mockQueue,
    );
    assert.equal(uploaded.documentType, 'faq');
    assert.equal(uploaded.status, 'queued');
    assert.equal(uploaded.currentVersion.status, 'queued');
    assert.equal(uploaded.currentVersion.versionNumber, 1);
    assert.equal(Object.hasOwn(uploaded.currentVersion, 'b2ObjectKey'), false, 'B2 keys must not be exposed');
    assert.equal(uploadedObjects.length, 1);
    assert.ok(uploadedObjects[0].key.startsWith(`tenants/${tenantA.tenantId}/`));
    assert.equal(uploadedObjects[0].metadata.tenant_id, tenantA.tenantId);

    const persisted = await client.query(
      `SELECT
         (SELECT count(*)::int FROM knowledge_documents WHERE id = $1) AS documents,
         (SELECT count(*)::int FROM knowledge_document_versions WHERE document_id = $1) AS versions,
         (SELECT count(*)::int FROM knowledge_processing_jobs WHERE document_id = $1) AS jobs,
         (SELECT count(*)::int FROM audit_logs WHERE entity_type = 'knowledge_document' AND entity_id = $1::text) AS audits`,
      [uploaded.id],
    );
    assert.deepEqual(persisted.rows[0], { documents: 1, versions: 1, jobs: 1, audits: 1 });

    const fetched = await getKnowledgeDocument(
      authA, tenantA.knowledgeBaseId, uploaded.id, sameTransaction,
    );
    assert.equal(fetched.id, uploaded.id);
    const listed = await listKnowledgeDocuments(authA, tenantA.knowledgeBaseId, {
      page: 1, pageSize: 20,
    }, sameTransaction);
    assert.equal(listed.pagination.total, 1);

    const beforeFailure = await client.query(
      'SELECT count(*)::int AS count FROM knowledge_documents WHERE knowledge_base_id = $1',
      [tenantA.knowledgeBaseId],
    );
    const failingStorage = {
      async putObject() { throw new Error('simulated B2 failure'); },
      async deleteObject() { assert.fail('Cleanup must not run when upload did not complete'); },
    };
    await assert.rejects(
      uploadKnowledgeDocument(
        authA,
        tenantA.knowledgeBaseId,
        { documentType: 'catalog', metadata: {} },
        validFile,
        failingStorage,
        sameTransaction,
        mockQueue,
      ),
      (error) => error.code === 'B2_UPLOAD_FAILED',
    );
    const afterFailure = await client.query(
      'SELECT count(*)::int AS count FROM knowledge_documents WHERE knowledge_base_id = $1',
      [tenantA.knowledgeBaseId],
    );
    assert.equal(afterFailure.rows[0].count, beforeFailure.rows[0].count);

    await client.query('SAVEPOINT metadata_failure');
    await assert.rejects(
      uploadKnowledgeDocument(
        authA,
        tenantA.knowledgeBaseId,
        { documentType: 'catalog', displayName: ' ', metadata: {} },
        validFile,
        mockStorage,
        sameTransaction,
        mockQueue,
      ),
      (error) => error.code === 'KNOWLEDGE_DOCUMENT_SAVE_FAILED',
    );
    await client.query('ROLLBACK TO SAVEPOINT metadata_failure');
    await client.query('RELEASE SAVEPOINT metadata_failure');
    assert.equal(deletedObjects.length, 1);
    assert.equal(deletedObjects[0].versionId, 'test-version');

    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantB.tenantId]);
    const authB = { ...authA, tenantId: tenantB.tenantId, workspaceId: tenantB.workspaceId };
    await assert.rejects(
      listKnowledgeDocuments(authB, tenantA.knowledgeBaseId, { page: 1, pageSize: 20 }, sameTransaction),
      (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND',
    );
    assert.equal(deletedObjects.length, 1);
  } finally {
    if (transactionStarted) {
      try {
        await client.query('RESET ROLE');
      } catch {
        // Rollback remains safe if the test transaction is already aborted.
      }
      await client.query('ROLLBACK');
    }
    await client.end();
  }
}

const validFile = verifyValidationAndRouting();
await verifyLivePersistence(validFile);

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 4 - Five-category PDF upload and B2 storage',
  verified: {
    documentCategories: KNOWLEDGE_DOCUMENT_TYPES.length,
    pdfValidation: true,
    tenantSafeObjectKeys: true,
    multipartRoutes: 3,
    b2FailureCompensation: true,
    exactB2VersionCleanup: true,
    tenantIsolatedPersistence: true,
    versionAndExtractionJobCreation: true,
  },
  realB2ObjectsCreated: false,
  databaseFixturesPersisted: false,
}, null, 2));
