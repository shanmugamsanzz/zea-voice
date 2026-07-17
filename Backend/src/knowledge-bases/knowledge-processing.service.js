import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { deleteB2Object, getB2Object, putB2Object } from '../rag/b2.client.js';
import { processExtractedCategory } from './category-processors.js';
import { extractPdfText } from './pdf-text-extractor.js';

const defaultDependencies = {
  extract: extractPdfText,
  storage: { getObject: getB2Object, putObject: putB2Object, deleteObject: deleteB2Object },
  contextRunner: withPlatformAdminContext,
};

function extractedTextKey(sourceKey) {
  return sourceKey.endsWith('/source.pdf')
    ? sourceKey.slice(0, -'/source.pdf'.length) + '/extracted-text.json'
    : `${sourceKey}.extracted-text.json`;
}

async function claimJob(jobId, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT j.*, d.document_type, d.status AS document_status,
          v.b2_bucket, v.b2_object_key, v.content_sha256, v.status AS version_status
         FROM knowledge_processing_jobs j
         JOIN knowledge_documents d
           ON d.tenant_id = j.tenant_id AND d.id = j.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id = j.tenant_id AND v.id = j.document_version_id
        WHERE j.id = $1 AND j.job_type = 'extract'
        FOR UPDATE OF j, d, v`,
      [jobId],
    );
    if (!result.rowCount) throw new AppError(404, 'Knowledge processing job was not found', 'KNOWLEDGE_JOB_NOT_FOUND');
    const job = result.rows[0];
    if (job.status === 'completed') return { ...job, alreadyCompleted: true };
    if (['deleting', 'deleted'].includes(job.document_status)
      || ['deleting', 'deleted'].includes(job.version_status)) {
      throw new AppError(409, 'Knowledge document is being deleted', 'KNOWLEDGE_DOCUMENT_DELETING');
    }
    if (job.attempt_count >= job.max_attempts) {
      throw new AppError(409, 'Knowledge processing job exhausted its retries', 'KNOWLEDGE_JOB_RETRIES_EXHAUSTED');
    }
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'running', progress = 5, attempt_count = attempt_count + 1,
              started_at = now(), completed_at = NULL, error_code = NULL, error_message = NULL
        WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE knowledge_documents SET status = 'processing'
        WHERE tenant_id = $1 AND id = $2`,
      [job.tenant_id, job.document_id],
    );
    await client.query(
      `UPDATE knowledge_document_versions SET status = 'processing'
        WHERE tenant_id = $1 AND id = $2`,
      [job.tenant_id, job.document_version_id],
    );
    await client.query(
      `UPDATE knowledge_bases SET status = 'processing'
        WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'`,
      [job.tenant_id, job.knowledge_base_id],
    );
    return { ...job, attempt_count: job.attempt_count + 1, alreadyCompleted: false };
  });
}

async function updateProgress(jobId, progress, contextRunner) {
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs SET progress = $2
      WHERE id = $1 AND status = 'running'`,
    [jobId, progress],
  ));
}

async function clearVersionRecords(client, job) {
  const values = [job.tenant_id, job.document_version_id];
  await client.query('DELETE FROM faq_entries WHERE tenant_id = $1 AND document_version_id = $2', values);
  await client.query('DELETE FROM structured_catalogs WHERE tenant_id = $1 AND document_version_id = $2', values);
  await client.query('DELETE FROM workflow_rules WHERE tenant_id = $1 AND document_version_id = $2', values);
  await client.query('DELETE FROM conversation_flows WHERE tenant_id = $1 AND document_version_id = $2', values);
  await client.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND document_version_id = $2', values);
}

async function persistFaq(client, job, result) {
  for (const record of result.records) {
    await client.query(
      `INSERT INTO faq_entries (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         question, answer, status, source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.question, record.answer, record.sourcePageStart, record.sourcePageEnd,
      ],
    );
  }
}

async function persistCatalog(client, job, result) {
  const currency = result.records[0]?.currency ?? null;
  const catalog = await client.query(
    `INSERT INTO structured_catalogs (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       catalog_type, name, default_currency, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft') RETURNING id`,
    [
      job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
      result.catalog.catalogType, result.catalog.name, currency,
    ],
  );
  for (const record of result.records) {
    await client.query(
      `INSERT INTO structured_items (
         tenant_id, knowledge_base_id, catalog_id, document_id, document_version_id,
         name, price, currency, display_order, status, source_text,
         source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12)`,
      [
        job.tenant_id, job.knowledge_base_id, catalog.rows[0].id,
        job.document_id, job.document_version_id, record.name, record.price,
        record.currency, record.displayOrder, record.sourceText,
        record.sourcePageStart, record.sourcePageEnd,
      ],
    );
  }
}

async function persistWorkflow(client, job, result) {
  for (const record of result.records) {
    await client.query(
      `INSERT INTO workflow_rules (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         name, intent, priority, conditions, action_type, action_config,
         response_template, status, source_text, source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9::jsonb,
         $10, 'draft', $11, $12, $13)`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.name, record.intent, record.priority, record.actionType,
        JSON.stringify(record.actionConfig), record.responseTemplate, record.sourceText,
        record.sourcePageStart, record.sourcePageEnd,
      ],
    );
  }
}

async function persistConversation(client, job, result) {
  for (const record of result.records) {
    await client.query(
      `INSERT INTO conversation_flows (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         flow_key, node_key, node_type, language, sequence_order, is_entry,
         content, variables, transitions, status, source_text,
         source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, '[]'::jsonb, '[]'::jsonb, 'draft', $12, $13, $14)`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.flowKey, record.nodeKey, record.nodeType, record.language,
        record.sequenceOrder, record.isEntry, record.content, record.sourceText,
        record.sourcePageStart, record.sourcePageEnd,
      ],
    );
  }
}

async function persistChunks(client, job, result) {
  for (const record of result.records) {
    await client.query(
      `INSERT INTO knowledge_chunks (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         chunk_index, content, token_count, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.chunkIndex, record.content, record.tokenCount,
      ],
    );
  }
}

const persistenceByType = {
  faq: persistFaq,
  catalog: persistCatalog,
  workflow_rules: persistWorkflow,
  conversation_script: persistConversation,
  general_knowledge: persistChunks,
};

async function completeJob(job, extraction, category, storedText, contextRunner) {
  return contextRunner(null, async (client) => {
    const current = await client.query(
      'SELECT status FROM knowledge_processing_jobs WHERE id = $1 FOR UPDATE',
      [job.id],
    );
    if (!current.rowCount || current.rows[0].status !== 'running') {
      throw new AppError(409, 'Knowledge processing job is no longer running', 'KNOWLEDGE_JOB_STATE_CHANGED');
    }
    await clearVersionRecords(client, job);
    await persistenceByType[job.document_type](client, job, category);

    const extractionMetadata = {
      extractor: 'pdfjs-dist',
      textOnly: true,
      ocrEnabled: false,
      characterCount: extraction.characterCount,
      wordCount: extraction.wordCount,
      recordCount: category.recordCount,
      warnings: category.warnings,
      extractedText: {
        etag: storedText.etag,
        storageVersionId: storedText.storageVersionId,
      },
      processedAt: new Date().toISOString(),
    };
    await client.query(
      `UPDATE knowledge_document_versions
          SET status = 'review_required', page_count = $3,
              extracted_text_object_key = $4, extraction_metadata = extraction_metadata || $5::jsonb,
              chunk_size_tokens = $6, chunk_overlap_tokens = $7,
              chunk_count = $8, processed_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [
        job.tenant_id, job.document_version_id, extraction.pageCount, storedText.key,
        JSON.stringify(extractionMetadata),
        job.document_type === 'general_knowledge' ? env.RAG_CHUNK_SIZE_TOKENS : null,
        job.document_type === 'general_knowledge' ? env.RAG_CHUNK_OVERLAP_TOKENS : null,
        job.document_type === 'general_knowledge' ? category.recordCount : 0,
      ],
    );
    await client.query(
      `UPDATE knowledge_documents SET status = 'review_required'
        WHERE tenant_id = $1 AND id = $2`,
      [job.tenant_id, job.document_id],
    );
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'completed', progress = 100, completed_at = now(),
              error_code = NULL, error_message = NULL,
              metadata = metadata || $2::jsonb
        WHERE id = $1`,
      [job.id, JSON.stringify({ recordCount: category.recordCount, warnings: category.warnings })],
    );
    await client.query(
      `UPDATE knowledge_bases kb
          SET status = CASE
            WHEN EXISTS (
              SELECT 1 FROM knowledge_documents d
               WHERE d.tenant_id = kb.tenant_id AND d.knowledge_base_id = kb.id
                 AND d.deleted_at IS NULL AND d.status = 'failed'
            ) THEN 'partially_failed'::knowledge_base_status
            WHEN EXISTS (
              SELECT 1 FROM knowledge_documents d
               WHERE d.tenant_id = kb.tenant_id AND d.knowledge_base_id = kb.id
                 AND d.deleted_at IS NULL AND d.status IN ('uploading', 'queued', 'processing')
            ) THEN 'processing'::knowledge_base_status
            ELSE 'ready'::knowledge_base_status
          END
        WHERE kb.tenant_id = $1 AND kb.id = $2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    return {
      jobId: job.id,
      tenantId: job.tenant_id,
      documentId: job.document_id,
      documentVersionId: job.document_version_id,
      documentType: job.document_type,
      pageCount: extraction.pageCount,
      wordCount: extraction.wordCount,
      recordCount: category.recordCount,
      warnings: category.warnings,
      status: 'review_required',
    };
  });
}

async function failJob(job, error, contextRunner) {
  const code = error instanceof AppError ? error.code : 'PDF_PROCESSING_FAILED';
  const message = String(error.message ?? 'PDF processing failed').slice(0, 4000);
  await contextRunner(null, async (client) => {
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
        WHERE id = $1 AND status <> 'completed'`,
      [job.id, code, message],
    );
    await client.query(
      `UPDATE knowledge_documents SET status = 'failed'
        WHERE tenant_id = $1 AND id = $2 AND status NOT IN ('deleting', 'deleted')`,
      [job.tenant_id, job.document_id],
    );
    await client.query(
      `UPDATE knowledge_document_versions
          SET status = 'failed', error_code = $3, error_message = $4
        WHERE tenant_id = $1 AND id = $2 AND status NOT IN ('deleting', 'deleted')`,
      [job.tenant_id, job.document_version_id, code, message],
    );
    await client.query(
      `UPDATE knowledge_bases SET status = 'partially_failed'
        WHERE tenant_id = $1 AND id = $2 AND status NOT IN ('deleting', 'deleted')`,
      [job.tenant_id, job.knowledge_base_id],
    );
  });
}

export async function processKnowledgeJob(jobId, dependencies = defaultDependencies) {
  const runtime = {
    ...defaultDependencies,
    ...dependencies,
    storage: { ...defaultDependencies.storage, ...dependencies.storage },
  };
  const job = await claimJob(jobId, runtime.contextRunner);
  if (job.alreadyCompleted) return { jobId, status: 'completed', skipped: true };
  let storedText;
  try {
    const source = await runtime.storage.getObject({
      key: job.b2_object_key,
      maxBytes: env.KNOWLEDGE_PDF_MAX_BYTES,
    });
    const checksum = crypto.createHash('sha256').update(source.body).digest('hex');
    if (checksum !== job.content_sha256) {
      throw new AppError(422, 'Stored PDF checksum does not match its database version', 'PDF_CHECKSUM_MISMATCH');
    }
    await updateProgress(jobId, 25, runtime.contextRunner);
    const extraction = await runtime.extract(source.body);
    await updateProgress(jobId, 60, runtime.contextRunner);
    const category = processExtractedCategory(job.document_type, extraction);
    const key = extractedTextKey(job.b2_object_key);
    const body = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      tenantId: job.tenant_id,
      knowledgeBaseId: job.knowledge_base_id,
      documentId: job.document_id,
      documentVersionId: job.document_version_id,
      pageCount: extraction.pageCount,
      characterCount: extraction.characterCount,
      wordCount: extraction.wordCount,
      pages: extraction.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
    }));
    storedText = await runtime.storage.putObject({
      key,
      body,
      contentType: 'application/json',
      metadata: {
        tenant_id: job.tenant_id,
        document_id: job.document_id,
        document_version_id: job.document_version_id,
      },
    });
    await updateProgress(jobId, 80, runtime.contextRunner);
    return await completeJob(job, extraction, category, storedText, runtime.contextRunner);
  } catch (error) {
    if (storedText) {
      try {
        await runtime.storage.deleteObject({
          key: storedText.key,
          versionId: storedText.storageVersionId,
        });
      } catch (cleanupError) {
        error.extractedTextCleanupError = cleanupError.message;
      }
    }
    await failJob(job, error, runtime.contextRunner);
    throw error;
  }
}
