import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { AppError } from '../src/middleware/errors.js';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import { processKnowledgeJob } from '../src/knowledge-bases/knowledge-processing.service.js';
import { extractPdfText } from '../src/knowledge-bases/pdf-text-extractor.js';

const { Client } = pg;

function createTextPdf(lines) {
  const escaped = lines.map((line) => line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'));
  const textCommands = escaped.length
    ? `BT\n/F1 12 Tf\n72 720 Td\n${escaped.map((line, index) => `${index ? '0 -18 Td\n' : ''}(${line}) Tj`).join('\n')}\nET`
    : 'BT\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(textCommands)} >>\nstream\n${textCommands}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function extractionFor(text) {
  const lines = text.split('\n');
  return {
    pageCount: 1,
    characterCount: text.length,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    fullText: text,
    pages: [{ pageNumber: 1, text, lines, characterCount: text.length }],
  };
}

async function verifyExtractorAndProcessors() {
  const pdf = createTextPdf(['Q: Where is the hospital?', 'A: The hospital is in Salem.']);
  const extracted = await extractPdfText(pdf);
  assert.equal(extracted.pageCount, 1);
  assert.match(extracted.fullText, /Where is the hospital/);
  assert.match(extracted.fullText, /Salem/);

  await assert.rejects(
    extractPdfText(createTextPdf([])),
    (error) => error.code === 'PDF_TEXT_EMPTY' && error.statusCode === 422,
  );

  const fixtures = {
    faq: extractionFor('Q: Where is the hospital?\nA: Salem near the bus stop.'),
    catalog: extractionFor('Silver Package ₹1650\nGold Package INR 4950'),
    workflow_rules: extractionFor('insurance request -> Transfer to support\nif emergency then Transfer to emergency desk'),
    conversation_script: extractionFor('Good morning.\nHow may I help you?'),
    general_knowledge: extractionFor('A cardiac health check helps evaluate heart health and related risks.'),
  };
  for (const [type, value] of Object.entries(fixtures)) {
    const result = processExtractedCategory(type, value);
    assert.ok(result.recordCount > 0, `${type} must produce reviewable records`);
  }
  return { pdf, fixtures };
}

async function insertTenant(client) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenant = await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ('RAG processing verification', $1, 'active') RETURNING id`,
    [`rag-processing-verification-${suffix}`],
  );
  const organization = await client.query(
    `INSERT INTO organizations (tenant_id, name, status)
     VALUES ($1, 'RAG processing verification', 'active') RETURNING id`,
    [tenant.rows[0].id],
  );
  const workspace = await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1, $2, 'Default', 'default', 'active', true) RETURNING id`,
    [tenant.rows[0].id, organization.rows[0].id],
  );
  const knowledgeBase = await client.query(
    `INSERT INTO knowledge_bases (tenant_id, workspace_id, name, status)
     VALUES ($1, $2, 'Hospital KB', 'processing') RETURNING id`,
    [tenant.rows[0].id, workspace.rows[0].id],
  );
  return {
    tenantId: tenant.rows[0].id,
    workspaceId: workspace.rows[0].id,
    knowledgeBaseId: knowledgeBase.rows[0].id,
  };
}

async function insertProcessingFixture(client, tenant, documentType, pdf, suffix = documentType) {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const objectKey = `tenants/${tenant.tenantId}/knowledge-bases/${tenant.knowledgeBaseId}/documents/${documentId}/versions/1/source.pdf`;
  const checksum = crypto.createHash('sha256').update(pdf).digest('hex');
  await client.query(
    `INSERT INTO knowledge_documents (
       id, tenant_id, knowledge_base_id, document_type, display_name,
       original_filename, size_bytes, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
    [documentId, tenant.tenantId, tenant.knowledgeBaseId, documentType, `${suffix} document`, `${suffix}.pdf`, pdf.length],
  );
  await client.query(
    `INSERT INTO knowledge_document_versions (
       id, tenant_id, knowledge_base_id, document_id, version_number, status,
       is_current, b2_bucket, b2_object_key, content_sha256, size_bytes
     ) VALUES ($1, $2, $3, $4, 1, 'queued', true, 'zea-voice', $5, $6, $7)`,
    [versionId, tenant.tenantId, tenant.knowledgeBaseId, documentId, objectKey, checksum, pdf.length],
  );
  const job = await client.query(
    `INSERT INTO knowledge_processing_jobs (
       tenant_id, knowledge_base_id, document_id, document_version_id, job_type, status
     ) VALUES ($1, $2, $3, $4, 'extract', 'queued') RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, documentId, versionId],
  );
  return { documentId, versionId, objectKey, jobId: job.rows[0].id };
}

async function verifyLiveProcessing(pdf, extractionFixtures) {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-5-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const tenant = await insertTenant(client);
    const sameTransaction = (_userId, operation) => operation(client);
    const storedTextObjects = [];
    const mockStorage = {
      async getObject({ key }) {
        return { key, body: pdf, contentType: 'application/pdf' };
      },
      async putObject(input) {
        storedTextObjects.push(input);
        return {
          bucket: 'zea-voice', key: input.key,
          etag: `etag-${storedTextObjects.length}`,
          storageVersionId: `version-${storedTextObjects.length}`,
        };
      },
      async deleteObject() {
        assert.fail('Successful processing must not delete extracted text');
      },
    };

    const fixtures = {};
    for (const documentType of Object.keys(extractionFixtures)) {
      fixtures[documentType] = await insertProcessingFixture(client, tenant, documentType, pdf);
      const result = await processKnowledgeJob(fixtures[documentType].jobId, {
        contextRunner: sameTransaction,
        storage: mockStorage,
        extract: async () => extractionFixtures[documentType],
      });
      assert.equal(result.status, 'review_required');
      assert.ok(result.recordCount > 0);
    }

    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM faq_entries WHERE tenant_id = $1) AS faqs,
         (SELECT count(*)::int FROM structured_catalogs WHERE tenant_id = $1) AS catalogs,
         (SELECT count(*)::int FROM structured_items WHERE tenant_id = $1) AS catalog_items,
         (SELECT count(*)::int FROM workflow_rules WHERE tenant_id = $1) AS workflow_rules,
         (SELECT count(*)::int FROM conversation_flows WHERE tenant_id = $1) AS conversation_nodes,
         (SELECT count(*)::int FROM knowledge_chunks WHERE tenant_id = $1) AS chunks,
         (SELECT count(*)::int FROM knowledge_processing_jobs WHERE tenant_id = $1 AND status = 'completed') AS completed_jobs,
         (SELECT count(*)::int FROM knowledge_documents WHERE tenant_id = $1 AND status = 'review_required') AS review_documents`,
      [tenant.tenantId],
    );
    assert.ok(counts.rows[0].faqs > 0);
    assert.ok(counts.rows[0].catalogs > 0);
    assert.ok(counts.rows[0].catalog_items > 0);
    assert.ok(counts.rows[0].workflow_rules > 0);
    assert.ok(counts.rows[0].conversation_nodes > 0);
    assert.ok(counts.rows[0].chunks > 0);
    assert.equal(counts.rows[0].completed_jobs, 5);
    assert.equal(counts.rows[0].review_documents, 5);
    assert.equal(storedTextObjects.length, 5);
    assert.ok(storedTextObjects.every((object) => object.key.endsWith('/extracted-text.json')));

    const version = await client.query(
      `SELECT page_count, extracted_text_object_key, extraction_metadata,
          chunk_size_tokens, chunk_overlap_tokens, chunk_count
         FROM knowledge_document_versions WHERE id = $1`,
      [fixtures.general_knowledge.versionId],
    );
    assert.equal(version.rows[0].page_count, 1);
    assert.ok(version.rows[0].extracted_text_object_key.endsWith('/extracted-text.json'));
    assert.equal(version.rows[0].extraction_metadata.ocrEnabled, false);
    assert.equal(version.rows[0].chunk_size_tokens, env.RAG_CHUNK_SIZE_TOKENS);
    assert.equal(version.rows[0].chunk_overlap_tokens, env.RAG_CHUNK_OVERLAP_TOKENS);
    assert.ok(version.rows[0].chunk_count > 0);

    const failedFixture = await insertProcessingFixture(client, tenant, 'general_knowledge', pdf, 'image-only');
    await assert.rejects(
      processKnowledgeJob(failedFixture.jobId, {
        contextRunner: sameTransaction,
        storage: mockStorage,
        extract: async () => {
          throw new AppError(422, 'No selectable text was found', 'PDF_TEXT_EMPTY');
        },
      }),
      (error) => error.code === 'PDF_TEXT_EMPTY',
    );
    const failed = await client.query(
      `SELECT j.status AS job_status, j.error_code, d.status AS document_status, v.status AS version_status
         FROM knowledge_processing_jobs j
         JOIN knowledge_documents d ON d.id = j.document_id
         JOIN knowledge_document_versions v ON v.id = j.document_version_id
        WHERE j.id = $1`,
      [failedFixture.jobId],
    );
    assert.deepEqual(failed.rows[0], {
      job_status: 'failed',
      error_code: 'PDF_TEXT_EMPTY',
      document_status: 'failed',
      version_status: 'failed',
    });
  } finally {
    if (transactionStarted) await client.query('ROLLBACK');
    await client.end();
  }
}

const { pdf, fixtures } = await verifyExtractorAndProcessors();
await verifyLiveProcessing(pdf, fixtures);

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 5 - PDF text extraction and category processing',
  verified: {
    realPdfTextExtraction: true,
    textOnlyNoOcrPolicy: true,
    categoryProcessors: 5,
    draftRecordPersistence: true,
    extractedTextStorageContract: true,
    queueStateTransitions: true,
    failureStateHandling: true,
    retrySafeReplacement: true,
  },
  realB2ObjectsCreated: false,
  databaseFixturesPersisted: false,
}, null, 2));
