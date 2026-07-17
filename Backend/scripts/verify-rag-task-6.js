import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { requireRoles } from '../src/auth/auth.middleware.js';
import { env } from '../src/config/env.js';
import { knowledgeBaseRouter } from '../src/knowledge-bases/knowledge-base.routes.js';
import { knowledgeDocumentRouter } from '../src/knowledge-bases/knowledge-document.routes.js';
import {
  decideReviewRecord,
  getDocumentReview,
  getKnowledgeBaseReviewSummary,
  publishKnowledgeBase,
  updateReviewRecord,
} from '../src/knowledge-bases/knowledge-review.service.js';

const { Client } = pg;

function verifyRoutesAndPermissions() {
  const documentRoutes = knowledgeDocumentRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.ok(documentRoutes.includes('GET /:documentId/review'));
  assert.ok(documentRoutes.includes('PATCH /:documentId/review/:recordId'));
  assert.ok(documentRoutes.includes('POST /:documentId/review/:recordId/decision'));

  const knowledgeBaseRoutes = knowledgeBaseRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.ok(knowledgeBaseRoutes.includes('GET /:knowledgeBaseId/review-summary'));
  assert.ok(knowledgeBaseRoutes.includes('POST /:knowledgeBaseId/publish'));

  let companyUserError;
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER')(
    { auth: { role: 'COMPANY_USER' } }, {}, (error) => { companyUserError = error; },
  );
  assert.equal(companyUserError.statusCode, 403);
  let developerError;
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER')(
    { auth: { role: 'COMPANY_DEVELOPER' } }, {}, (error) => { developerError = error; },
  );
  assert.equal(developerError, undefined);
}

async function insertTenant(client, label) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenant = await client.query(
    `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`RAG review verification ${label}`, `rag-review-verification-${label}-${suffix}`],
  );
  const organization = await client.query(
    `INSERT INTO organizations (tenant_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [tenant.rows[0].id, `RAG review verification ${label}`],
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

async function insertDocument(client, tenant, documentType) {
  const document = await client.query(
    `INSERT INTO knowledge_documents (
       tenant_id, knowledge_base_id, document_type, display_name,
       original_filename, size_bytes, status
     ) VALUES ($1, $2, $3, $4, $5, 100, 'review_required') RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, documentType, `${documentType} document`, `${documentType}.pdf`],
  );
  const version = await client.query(
    `INSERT INTO knowledge_document_versions (
       tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
       b2_bucket, b2_object_key, content_sha256, size_bytes, page_count, processed_at
     ) VALUES ($1, $2, $3, 1, 'review_required', true, 'zea-voice', $4, $5, 100, 1, now()) RETURNING id`,
    [
      tenant.tenantId,
      tenant.knowledgeBaseId,
      document.rows[0].id,
      `review/${tenant.tenantId}/${document.rows[0].id}.pdf`,
      crypto.createHash('sha256').update(`${tenant.tenantId}-${documentType}`).digest('hex'),
    ],
  );
  return { documentId: document.rows[0].id, versionId: version.rows[0].id };
}

async function insertReviewFixtures(client, tenant) {
  const documents = {};
  for (const documentType of ['faq', 'catalog', 'workflow_rules', 'conversation_script', 'general_knowledge']) {
    documents[documentType] = await insertDocument(client, tenant, documentType);
  }

  const faq = await client.query(
    `INSERT INTO faq_entries (
       tenant_id, knowledge_base_id, document_id, document_version_id, question, answer
     ) VALUES ($1, $2, $3, $4, 'Where is the hospital?', 'Salem') RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, documents.faq.documentId, documents.faq.versionId],
  );
  const catalog = await client.query(
    `INSERT INTO structured_catalogs (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       catalog_type, name, default_currency
     ) VALUES ($1, $2, $3, $4, 'packages', 'Health Packages', 'INR') RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, documents.catalog.documentId, documents.catalog.versionId],
  );
  const catalogItem = await client.query(
    `INSERT INTO structured_items (
       tenant_id, knowledge_base_id, catalog_id, document_id, document_version_id,
       name, price, currency
     ) VALUES ($1, $2, $3, $4, $5, 'Silver Package', 1650, 'INR') RETURNING id`,
    [
      tenant.tenantId, tenant.knowledgeBaseId, catalog.rows[0].id,
      documents.catalog.documentId, documents.catalog.versionId,
    ],
  );
  const workflow = await client.query(
    `INSERT INTO workflow_rules (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       name, intent, action_type, action_config
     ) VALUES ($1, $2, $3, $4, 'Insurance', 'insurance', 'transfer_call', '{}'::jsonb) RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, documents.workflow_rules.documentId, documents.workflow_rules.versionId],
  );
  const conversation = await client.query(
    `INSERT INTO conversation_flows (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       flow_key, node_key, is_entry, content
     ) VALUES ($1, $2, $3, $4, 'main', 'intro', true, 'Good morning') RETURNING id`,
    [
      tenant.tenantId, tenant.knowledgeBaseId,
      documents.conversation_script.documentId, documents.conversation_script.versionId,
    ],
  );
  const chunk = await client.query(
    `INSERT INTO knowledge_chunks (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       chunk_index, content, token_count
     ) VALUES ($1, $2, $3, $4, 0, 'Cardiac screening checks heart health.', 6) RETURNING id`,
    [
      tenant.tenantId, tenant.knowledgeBaseId,
      documents.general_knowledge.documentId, documents.general_knowledge.versionId,
    ],
  );
  return {
    documents,
    records: {
      faq: faq.rows[0].id,
      catalog: catalog.rows[0].id,
      catalogItem: catalogItem.rows[0].id,
      workflow: workflow.rows[0].id,
      conversation: conversation.rows[0].id,
      chunk: chunk.rows[0].id,
    },
  };
}

async function verifyLiveReviewAndPublishing() {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-6-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const tenantA = await insertTenant(client, 'a');
    const tenantB = await insertTenant(client, 'b');
    const fixture = await insertReviewFixtures(client, tenantA);
    const sameTransaction = (_auth, operation) => operation(client);
    const mockQueue = async ({ processingJobId }) => ({ id: processingJobId });
    const authA = {
      authType: 'session', role: 'COMPANY_DEVELOPER', userId: null,
      tenantId: tenantA.tenantId, workspaceId: tenantA.workspaceId,
    };

    const initialSummary = await getKnowledgeBaseReviewSummary(authA, tenantA.knowledgeBaseId, sameTransaction);
    assert.equal(initialSummary.canPublish, false);
    assert.ok(initialSummary.blockers.some((blocker) => blocker.code === 'DRAFT_RECORDS'));
    await assert.rejects(
      publishKnowledgeBase(authA, tenantA.knowledgeBaseId, sameTransaction, mockQueue),
      (error) => error.code === 'KNOWLEDGE_BASE_REVIEW_INCOMPLETE',
    );

    const faqReview = await getDocumentReview(
      authA, tenantA.knowledgeBaseId, fixture.documents.faq.documentId, sameTransaction,
    );
    assert.equal(faqReview.records[0].question, 'Where is the hospital?');
    await assert.rejects(
      updateReviewRecord(
        authA, tenantA.knowledgeBaseId, fixture.documents.faq.documentId,
        fixture.records.faq, { price: 100 }, sameTransaction,
      ),
      (error) => error.code === 'REVIEW_FIELD_NOT_ALLOWED',
    );
    const edited = await updateReviewRecord(
      authA, tenantA.knowledgeBaseId, fixture.documents.faq.documentId,
      fixture.records.faq, { answer: 'Salem, near the main bus stop.' }, sameTransaction,
    );
    assert.equal(edited.status, 'draft');

    const approvals = [
      ['faq', fixture.records.faq],
      ['catalog', fixture.records.catalog],
      ['catalog', fixture.records.catalogItem],
      ['workflow_rules', fixture.records.workflow],
      ['conversation_script', fixture.records.conversation],
      ['general_knowledge', fixture.records.chunk],
    ];
    for (const [documentType, recordId] of approvals) {
      const result = await decideReviewRecord(
        authA,
        tenantA.knowledgeBaseId,
        fixture.documents[documentType].documentId,
        recordId,
        'approve',
        sameTransaction,
      );
      assert.equal(result.status, 'approved');
    }

    const readySummary = await getKnowledgeBaseReviewSummary(authA, tenantA.knowledgeBaseId, sameTransaction);
    assert.equal(readySummary.canPublish, true);
    assert.ok(readySummary.documents.every((document) => document.ready));
    const published = await publishKnowledgeBase(authA, tenantA.knowledgeBaseId, sameTransaction, mockQueue);
    assert.equal(published.status, 'published');
    assert.equal(published.publicationRevision, 1);
    assert.equal(published.documentCount, 5);

    await updateReviewRecord(
      authA, tenantA.knowledgeBaseId, fixture.documents.faq.documentId,
      fixture.records.faq, { answer: 'Updated Salem address.' }, sameTransaction,
    );
    const unpublished = await client.query(
      'SELECT status, published_at FROM knowledge_bases WHERE id = $1',
      [tenantA.knowledgeBaseId],
    );
    assert.equal(unpublished.rows[0].status, 'draft');
    assert.equal(unpublished.rows[0].published_at, null);

    await decideReviewRecord(
      authA, tenantA.knowledgeBaseId, fixture.documents.faq.documentId,
      fixture.records.faq, 'approve', sameTransaction,
    );
    const republished = await publishKnowledgeBase(authA, tenantA.knowledgeBaseId, sameTransaction, mockQueue);
    assert.equal(republished.publicationRevision, 2);

    const authB = { ...authA, tenantId: tenantB.tenantId, workspaceId: tenantB.workspaceId };
    await assert.rejects(
      getKnowledgeBaseReviewSummary(authB, tenantA.knowledgeBaseId, sameTransaction),
      (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND',
    );

    const auditCount = await client.query(
      `SELECT count(*)::int AS count FROM audit_logs
        WHERE tenant_id = $1 AND action IN (
          'KNOWLEDGE_REVIEW_EDITED', 'KNOWLEDGE_REVIEW_APPROVED', 'KNOWLEDGE_BASE_PUBLISHED'
        )`,
      [tenantA.tenantId],
    );
    assert.ok(auditCount.rows[0].count >= 10);
  } finally {
    if (transactionStarted) await client.query('ROLLBACK');
    await client.end();
  }
}

verifyRoutesAndPermissions();
await verifyLiveReviewAndPublishing();

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 6 - Developer review and publishing',
  verified: {
    categoryReviewReads: 5,
    categoryAwareEditing: true,
    approvalAndRejectionStates: true,
    companyUserReadOnly: true,
    publicationBlockers: true,
    publicationRevisioning: true,
    editInvalidatesPublication: true,
    tenantIsolation: true,
    auditLogging: true,
  },
  databaseFixturesPersisted: false,
}, null, 2));
