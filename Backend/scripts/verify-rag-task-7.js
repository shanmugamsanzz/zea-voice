import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { env } from '../src/config/env.js';
import {
  collectionForTenant,
  deleteTenantCollection,
  deleteTenantPointsByKnowledgeBase,
  ensureTenantCollection,
  upsertTenantPoints,
} from '../src/rag/qdrant.client.js';
import { embedPassages } from '../src/rag/embedding.client.js';
import { tenantVectorPayload } from '../src/rag/tenant-isolation.js';
import { processSemanticIndexJob } from '../src/knowledge-bases/semantic-index.service.js';

const { Client } = pg;

async function verifyQdrantClientContract() {
  const tenantId = '3a76a9bb-3206-4b86-b7f5-4960c834e1e6';
  const knowledgeBaseId = '4f662796-6017-4e2a-8db8-21cba7927db3';
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    if ((options.method ?? 'GET') === 'GET' && String(url).includes('/collections/')) {
      return new Response(JSON.stringify({ status: { error: 'Not found' } }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ result: true, status: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const collection = await ensureTenantCollection(tenantId);
    assert.equal(collection.created, true);
    assert.equal(collection.collectionName, collectionForTenant(tenantId));
    assert.equal(calls.filter((call) => call.url.includes('/index?wait=true')).length, 8);
    const create = calls.find((call) => call.method === 'PUT' && call.body?.vectors);
    assert.deepEqual(create.body.vectors, { size: 384, distance: 'Cosine' });

    await upsertTenantPoints(tenantId, [{
      id: knowledgeBaseId,
      vector: Array(384).fill(0),
      payload: { tenant_id: tenantId },
    }]);
    await deleteTenantPointsByKnowledgeBase(tenantId, knowledgeBaseId, {
      publicationRevision: 2, revisionMode: 'older',
    });
    const deletion = calls.find((call) => call.url.includes('/points/delete'));
    assert.deepEqual(deletion.body.filter.must.at(-1), {
      key: 'publication_revision', range: { lt: 2 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function insertTenant(client) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenant = await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ('Semantic index verification', $1, 'active') RETURNING id`,
    [`semantic-index-verification-${suffix}`],
  );
  const organization = await client.query(
    `INSERT INTO organizations (tenant_id, name, status)
     VALUES ($1, 'Semantic index verification', 'active') RETURNING id`,
    [tenant.rows[0].id],
  );
  const workspace = await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1, $2, 'Default', 'default', 'active', true) RETURNING id`,
    [tenant.rows[0].id, organization.rows[0].id],
  );
  const knowledgeBase = await client.query(
    `INSERT INTO knowledge_bases (
       tenant_id, workspace_id, name, status, publication_revision, published_at
     ) VALUES ($1, $2, 'Hospital KB', 'published', 1, now()) RETURNING id`,
    [tenant.rows[0].id, workspace.rows[0].id],
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
     ) VALUES ($1, $2, $3, $4, $5, 100, 'ready') RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, documentType, `${documentType} document`, `${documentType}.pdf`],
  );
  const version = await client.query(
    `INSERT INTO knowledge_document_versions (
       tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
       b2_bucket, b2_object_key, content_sha256, size_bytes, page_count, processed_at
     ) VALUES ($1, $2, $3, 1, 'ready', true, 'zea-voice', $4, $5, 100, 1, now()) RETURNING id`,
    [
      tenant.tenantId,
      tenant.knowledgeBaseId,
      document.rows[0].id,
      `index/${tenant.tenantId}/${document.rows[0].id}.pdf`,
      crypto.createHash('sha256').update(`${tenant.tenantId}-${documentType}`).digest('hex'),
    ],
  );
  return { documentId: document.rows[0].id, versionId: version.rows[0].id };
}

async function insertSemanticFixtures(client, tenant) {
  const faqDocument = await insertDocument(client, tenant, 'faq');
  const chunkDocument = await insertDocument(client, tenant, 'general_knowledge');
  const catalogDocument = await insertDocument(client, tenant, 'catalog');
  const faq = await client.query(
    `INSERT INTO faq_entries (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       question, answer, status, approved_at
     ) VALUES ($1, $2, $3, $4, 'Where is the hospital?', 'The hospital is in Salem.', 'approved', now())
     RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, faqDocument.documentId, faqDocument.versionId],
  );
  const chunk = await client.query(
    `INSERT INTO knowledge_chunks (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       chunk_index, content, token_count, status, approved_at
     ) VALUES ($1, $2, $3, $4, 0, 'Cardiac screening evaluates heart health.', 6, 'approved', now())
     RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, chunkDocument.documentId, chunkDocument.versionId],
  );
  const catalog = await client.query(
    `INSERT INTO structured_catalogs (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       catalog_type, name, status, approved_at
     ) VALUES ($1, $2, $3, $4, 'packages', 'Packages', 'approved', now()) RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, catalogDocument.documentId, catalogDocument.versionId],
  );
  await client.query(
    `INSERT INTO structured_items (
       tenant_id, knowledge_base_id, catalog_id, document_id, document_version_id,
       name, price, currency, status, approved_at
     ) VALUES ($1, $2, $3, $4, $5, 'Silver Package', 1650, 'INR', 'approved', now())`,
    [
      tenant.tenantId, tenant.knowledgeBaseId, catalog.rows[0].id,
      catalogDocument.documentId, catalogDocument.versionId,
    ],
  );
  const job = await client.query(
    `INSERT INTO knowledge_processing_jobs (
       tenant_id, knowledge_base_id, job_type, status, metadata
     ) VALUES ($1, $2, 'index', 'queued', '{"publicationRevision":1}'::jsonb) RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId],
  );
  return {
    faqId: faq.rows[0].id,
    chunkId: chunk.rows[0].id,
    faqVersionId: faqDocument.versionId,
    chunkVersionId: chunkDocument.versionId,
    jobId: job.rows[0].id,
  };
}

async function verifyLiveSemanticIndexing() {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-7-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const tenant = await insertTenant(client);
    const fixture = await insertSemanticFixtures(client, tenant);
    const sameTransaction = (_userId, operation) => operation(client);
    const embeddedTexts = [];
    const ensuredTenants = [];
    const deletedFilters = [];
    const indexedPoints = [];
    const dependencies = {
      contextRunner: sameTransaction,
      async embed(values) {
        embeddedTexts.push(...values);
        return values.map((_value, index) => Array.from(
          { length: env.EMBEDDING_DIMENSIONS }, (_entry, vectorIndex) => vectorIndex === index ? 1 : 0,
        ));
      },
      async ensureCollection(tenantId) {
        ensuredTenants.push(tenantId);
        return { collectionName: collectionForTenant(tenantId), created: true };
      },
      async deleteKnowledgeBasePoints(tenantId, knowledgeBaseId, options) {
        deletedFilters.push({ tenantId, knowledgeBaseId, options });
        return { deleted: true };
      },
      async upsertPoints(tenantId, points) {
        indexedPoints.push(...points.map((point) => ({ ...point, tenantId })));
        return { count: points.length };
      },
    };

    const result = await processSemanticIndexJob(fixture.jobId, dependencies);
    assert.equal(result.status, 'completed');
    assert.equal(result.indexedRecordCount, 2);
    assert.equal(embeddedTexts.length, 2);
    assert.equal(indexedPoints.length, 2, 'Catalog data must remain in PostgreSQL and not be embedded');
    assert.deepEqual(new Set(indexedPoints.map((point) => point.payload.record_type)),
      new Set(['FAQ', 'KNOWLEDGE_CHUNK']));
    assert.ok(indexedPoints.every((point) => point.payload.tenant_id === tenant.tenantId));
    assert.ok(indexedPoints.every((point) => point.payload.publication_revision === 1));
    assert.ok(indexedPoints.every((point) => point.vector.length === 384));
    assert.deepEqual(ensuredTenants, [tenant.tenantId]);
    assert.deepEqual(deletedFilters.map((entry) => entry.options.revisionMode), ['equal', 'older']);

    const persisted = await client.query(
      `SELECT
         (SELECT qdrant_point_id FROM faq_entries WHERE id = $1) AS faq_point_id,
         (SELECT qdrant_point_id FROM knowledge_chunks WHERE id = $2) AS chunk_point_id,
         (SELECT status FROM knowledge_processing_jobs WHERE id = $3) AS job_status,
         (SELECT embedding_model FROM knowledge_document_versions WHERE id = $4) AS faq_model,
         (SELECT embedding_dimensions FROM knowledge_document_versions WHERE id = $5) AS chunk_dimensions`,
      [fixture.faqId, fixture.chunkId, fixture.jobId, fixture.faqVersionId, fixture.chunkVersionId],
    );
    assert.equal(persisted.rows[0].faq_point_id, fixture.faqId);
    assert.equal(persisted.rows[0].chunk_point_id, fixture.chunkId);
    assert.equal(persisted.rows[0].job_status, 'completed');
    assert.equal(persisted.rows[0].faq_model, env.EMBEDDING_MODEL);
    assert.equal(persisted.rows[0].chunk_dimensions, 384);

    const failedJob = await client.query(
      `INSERT INTO knowledge_processing_jobs (
         tenant_id, knowledge_base_id, job_type, status, metadata
       ) VALUES ($1, $2, 'index', 'queued', '{"publicationRevision":1}'::jsonb) RETURNING id`,
      [tenant.tenantId, tenant.knowledgeBaseId],
    );
    await assert.rejects(
      processSemanticIndexJob(failedJob.rows[0].id, {
        ...dependencies,
        async embed() { throw new Error('simulated embedding failure'); },
      }),
      /simulated embedding failure/,
    );
    const failure = await client.query(
      `SELECT j.status AS job_status, j.error_code, kb.status AS knowledge_base_status
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb ON kb.id = j.knowledge_base_id
        WHERE j.id = $1`,
      [failedJob.rows[0].id],
    );
    assert.deepEqual(failure.rows[0], {
      job_status: 'failed',
      error_code: 'KNOWLEDGE_INDEX_FAILED',
      knowledge_base_status: 'partially_failed',
    });

    const anotherTenant = crypto.randomUUID();
    assert.notEqual(collectionForTenant(tenant.tenantId), collectionForTenant(anotherTenant));
  } finally {
    if (transactionStarted) await client.query('ROLLBACK');
    await client.end();
  }
}

async function verifyLiveProvidersWhenRequested() {
  if (process.env.RAG_TASK7_LIVE_QDRANT !== 'true') return false;
  const tenantId = crypto.randomUUID();
  const knowledgeBaseId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const documentVersionId = crypto.randomUUID();
  const recordId = crypto.randomUUID();
  try {
    await ensureTenantCollection(tenantId);
    const [vector] = await embedPassages(['Temporary semantic indexing verification record.']);
    await upsertTenantPoints(tenantId, [{
      id: recordId,
      vector,
      payload: tenantVectorPayload({
        tenantId,
        knowledgeBaseId,
        documentId,
        documentVersionId,
        recordId,
        recordType: 'knowledge_chunk',
        agentUsage: 'BOTH',
        category: 'general_knowledge',
        publicationRevision: 1,
        content: 'Temporary semantic indexing verification record.',
      }),
    }]);
    return true;
  } finally {
    await deleteTenantCollection(tenantId);
  }
}

await verifyQdrantClientContract();
await verifyLiveSemanticIndexing();
const liveProvidersVerified = await verifyLiveProvidersWhenRequested();

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 7 - Qdrant and semantic indexing',
  verified: {
    separateTenantCollections: true,
    frozenVectorConfiguration: true,
    payloadIndexes: 8,
    approvedSemanticTypes: ['faq', 'general_knowledge'],
    structuredDataNotEmbedded: true,
    deterministicPointIds: true,
    publicationRevisionIsolation: true,
    retryAndFailureState: true,
  },
  liveQdrantAndEmbeddingVerified: liveProvidersVerified,
  temporaryQdrantCollectionDeleted: liveProvidersVerified,
  databaseFixturesPersisted: false,
}, null, 2));
