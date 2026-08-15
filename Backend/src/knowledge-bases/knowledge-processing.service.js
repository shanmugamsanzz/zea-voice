import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { deleteB2Object, getB2Object, putB2Object } from '../rag/b2.client.js';
import { processExtractedCategory } from './category-processors.js';
import { extractKnowledgeSource } from './knowledge-source-extractor.js';

const defaultDependencies = {
  extract: extractKnowledgeSource,
  storage: { getObject: getB2Object, putObject: putB2Object, deleteObject: deleteB2Object },
  contextRunner: withPlatformAdminContext,
};

function extractedTextKey(sourceKey) {
  return /\/source\.(?:pdf|txt)$/i.test(sourceKey)
    ? sourceKey.replace(/\/source\.(?:pdf|txt)$/i, '/extracted-text.json')
    : `${sourceKey}.extracted-text.json`;
}

async function lockProcessingKnowledgeBase(client, tenantId, knowledgeBaseId) {
  const result = await client.query(
    `SELECT status, deleted_at FROM knowledge_bases
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, knowledgeBaseId],
  );
  if (!result.rowCount || result.rows[0].deleted_at
    || ['deleting', 'deleted'].includes(result.rows[0].status)) {
    throw new AppError(409, 'Knowledge Base is being deleted', 'KNOWLEDGE_DOCUMENT_DELETING');
  }
}

async function claimJob(jobId, contextRunner) {
  return contextRunner(null, async (client) => {
    const locator = await client.query(
      `SELECT tenant_id, knowledge_base_id FROM knowledge_processing_jobs
        WHERE id=$1 AND job_type='extract'`,
      [jobId],
    );
    if (!locator.rowCount) throw new AppError(404, 'Knowledge processing job was not found', 'KNOWLEDGE_JOB_NOT_FOUND');
    await lockProcessingKnowledgeBase(
      client,
      locator.rows[0].tenant_id,
      locator.rows[0].knowledge_base_id,
    );
    const result = await client.query(
      `SELECT j.*, d.document_type,
          COALESCE(NULLIF(d.metadata->>'language', ''), 'und') AS document_language,
          kb.usage_direction AS knowledge_base_usage,
          COALESCE(v.extraction_metadata #>> '{source,originalFilename}', d.original_filename) AS source_filename,
          d.status AS document_status,
          COALESCE(v.extraction_metadata #>> '{source,mimeType}', d.mime_type, 'application/pdf') AS source_mime_type,
          v.b2_bucket, v.b2_object_key, v.content_sha256, v.status AS version_status
         FROM knowledge_processing_jobs j
         JOIN knowledge_documents d
           ON d.tenant_id = j.tenant_id AND d.id = j.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id = j.tenant_id AND v.id = j.document_version_id
         JOIN knowledge_bases kb
           ON kb.tenant_id = j.tenant_id AND kb.id = j.knowledge_base_id
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
        WHERE tenant_id = $1 AND id = $2 AND status NOT IN ('deleting', 'deleted')`,
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
         question, answer, language, usage_direction, status, source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10)`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.question, record.answer, record.language ?? job.document_language,
        job.knowledge_base_usage, record.sourcePageStart, record.sourcePageEnd,
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
    const item = await client.query(
      `INSERT INTO structured_items (
         tenant_id, knowledge_base_id, catalog_id, document_id, document_version_id,
         item_key, name, category, category_key, parent_category_key, category_description,
         category_selection_rules, category_aliases, aliases, relationships, selection_rules,
         price, currency, display_order, status, source_text, source_page_start, source_page_end
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
         $17, $18, $19, 'draft', $20, $21, $22
       ) RETURNING id`,
      [
        job.tenant_id, job.knowledge_base_id, catalog.rows[0].id,
        job.document_id, job.document_version_id, record.itemKey, record.name, record.category,
        record.categoryKey, record.parentCategoryKey, record.categoryDescription,
        JSON.stringify(record.categorySelectionRules ?? {}),
        JSON.stringify(record.categoryAliases ?? []), JSON.stringify(record.aliases ?? []),
        JSON.stringify(record.relationships ?? {}), JSON.stringify(record.selectionRules ?? {}), record.price,
        record.currency, record.displayOrder, record.sourceText,
        record.sourcePageStart, record.sourcePageEnd,
      ],
    );
    for (const attribute of record.attributes ?? []) {
      await client.query(
        `INSERT INTO structured_item_attributes (
           tenant_id, knowledge_base_id, item_id, document_id, document_version_id,
           attribute_key, display_name, value, display_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          job.tenant_id, job.knowledge_base_id, item.rows[0].id,
          job.document_id, job.document_version_id, attribute.key, attribute.name,
          JSON.stringify(attribute.value), attribute.displayOrder,
        ],
      );
    }
  }
}

async function persistWorkflow(client, job, result) {
  for (const record of result.records) {
    await client.query(
      `INSERT INTO workflow_rules (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         name, intent, priority, conditions, action_type, action_config,
         response_template, usage_direction, status, source_text, source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb,
         $11, $12, 'draft', $13, $14, $15)`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.name, record.intent, record.priority, JSON.stringify(record.conditions ?? {}),
        record.actionType, JSON.stringify(record.actionConfig ?? {}), record.responseTemplate,
        job.knowledge_base_usage, record.sourceText, record.sourcePageStart, record.sourcePageEnd,
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
         content, variables, transitions, usage_direction, status, source_text,
         source_page_start, source_page_end
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12::jsonb, $13::jsonb, $14, 'draft', $15, $16, $17)`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.flowKey, record.nodeKey, record.nodeType, record.language,
        record.sequenceOrder, record.isEntry, record.content,
        JSON.stringify(record.variables ?? []), JSON.stringify(record.transitions ?? []),
        job.knowledge_base_usage, record.sourceText, record.sourcePageStart, record.sourcePageEnd,
      ],
    );
  }
}

async function persistChunks(client, job, result) {
  for (const record of result.records) {
    await client.query(
      `INSERT INTO knowledge_chunks (
         tenant_id, knowledge_base_id, document_id, document_version_id,
         chunk_index, content, token_count, usage_direction, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')`,
      [
        job.tenant_id, job.knowledge_base_id, job.document_id, job.document_version_id,
        record.chunkIndex, record.content, record.tokenCount, job.knowledge_base_usage,
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
    await lockProcessingKnowledgeBase(client, job.tenant_id, job.knowledge_base_id);
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
      extractor: job.source_mime_type === 'text/plain' ? 'utf8-text' : 'pdfjs-dist',
      textOnly: true,
      ocrEnabled: false,
      characterCount: extraction.characterCount,
      wordCount: extraction.wordCount,
      recordCount: category.recordCount,
      warnings: category.warnings,
      validationErrors: category.errors ?? [],
      extractedText: {
        etag: storedText.etag,
        storageVersionId: storedText.storageVersionId,
      },
      source: {
        originalFilename: job.source_filename,
        mimeType: job.source_mime_type,
        format: job.source_mime_type === 'text/plain' ? 'txt' : 'pdf',
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
      [job.id, JSON.stringify({
        recordCount: category.recordCount,
        warnings: category.warnings,
        validationErrors: category.errors ?? [],
      })],
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
        WHERE kb.tenant_id = $1 AND kb.id = $2 AND kb.status NOT IN ('deleting', 'deleted')`,
      [job.tenant_id, job.knowledge_base_id],
    );
    return {
      jobId: job.id,
      tenantId: job.tenant_id,
      documentId: job.document_id,
      documentVersionId: job.document_version_id,
      source: {
        originalFilename: job.source_filename,
        mimeType: job.source_mime_type,
        format: job.source_mime_type === 'text/plain' ? 'txt' : 'pdf',
      },
      documentType: job.document_type,
      pageCount: extraction.pageCount,
      wordCount: extraction.wordCount,
      recordCount: category.recordCount,
      warnings: category.warnings,
      validationErrors: category.errors ?? [],
      status: 'review_required',
    };
  });
}

async function failJob(job, error, contextRunner) {
  const code = error instanceof AppError ? error.code : 'KNOWLEDGE_SOURCE_PROCESSING_FAILED';
  const message = String(error.message ?? 'Knowledge source processing failed').slice(0, 4000);
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
      throw new AppError(422, 'Stored source checksum does not match its database version', 'KNOWLEDGE_SOURCE_CHECKSUM_MISMATCH');
    }
    await updateProgress(jobId, 25, runtime.contextRunner);
    const extraction = await runtime.extract(source.body, job.source_mime_type);
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
