import { env } from '../config/env.js';
import { embedPassages } from '../rag/embedding.client.js';
import {
  deleteTenantPointsByKnowledgeBase,
  ensureTenantCollection,
  upsertTenantPoints,
} from '../rag/qdrant.client.js';
import { tenantVectorPayload } from '../rag/tenant-isolation.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

const defaultDependencies = {
  contextRunner: withPlatformAdminContext,
  embed: embedPassages,
  ensureCollection: ensureTenantCollection,
  deleteKnowledgeBasePoints: deleteTenantPointsByKnowledgeBase,
  upsertPoints: upsertTenantPoints,
};

function embeddingText(value) {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= env.RAG_EMBEDDING_MAX_CHARS) return normalized;
  const truncated = normalized.slice(0, env.RAG_EMBEDDING_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > env.RAG_EMBEDDING_MAX_CHARS * 0.8 ? truncated.slice(0, lastSpace) : truncated).trim();
}

async function claimIndexJob(jobId, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT j.*, kb.status AS knowledge_base_status,
          kb.publication_revision, kb.usage_direction AS knowledge_base_usage
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb ON kb.tenant_id = j.tenant_id AND kb.id = j.knowledge_base_id
        WHERE j.id = $1 AND j.job_type = 'index'
        FOR UPDATE OF j, kb`,
      [jobId],
    );
    if (!result.rowCount) throw new AppError(404, 'Semantic index job was not found', 'KNOWLEDGE_INDEX_JOB_NOT_FOUND');
    const job = result.rows[0];
    if (job.status === 'completed') return { ...job, alreadyCompleted: true };
    const targetRevision = Number(job.metadata?.publicationRevision);
    if (!Number.isInteger(targetRevision) || targetRevision < 1) {
      throw new AppError(409, 'Semantic index job has no valid publication revision', 'KNOWLEDGE_INDEX_REVISION_INVALID');
    }
    if (job.publication_revision !== targetRevision
      || !['published', 'partially_failed'].includes(job.knowledge_base_status)) {
      await client.query(
        `UPDATE knowledge_processing_jobs
            SET status = 'cancelled', completed_at = now(), error_code = 'KNOWLEDGE_INDEX_STALE',
                error_message = 'Knowledge Base changed before semantic indexing began'
          WHERE id = $1`,
        [jobId],
      );
      return { ...job, targetRevision, stale: true };
    }
    if (job.attempt_count >= job.max_attempts) {
      throw new AppError(409, 'Semantic index job exhausted its retries', 'KNOWLEDGE_INDEX_RETRIES_EXHAUSTED');
    }
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'running', progress = 5, attempt_count = attempt_count + 1,
              started_at = now(), completed_at = NULL, error_code = NULL, error_message = NULL
        WHERE id = $1`,
      [jobId],
    );
    return { ...job, targetRevision, attempt_count: job.attempt_count + 1, alreadyCompleted: false };
  });
}

async function loadSemanticRecords(job, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT f.id AS record_id, 'faq'::text AS record_type,
          f.document_id, f.document_version_id, f.usage_direction,
          f.source_page_start, f.question, f.answer,
          ('Question: ' || f.question || E'\nAnswer: ' || f.answer) AS content
         FROM faq_entries f
         JOIN knowledge_documents d
           ON d.tenant_id = f.tenant_id AND d.id = f.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id = f.tenant_id AND v.id = f.document_version_id
        WHERE f.tenant_id = $1 AND f.knowledge_base_id = $2
          AND f.status = 'approved' AND d.status = 'ready'
          AND v.is_current = true AND v.status = 'ready' AND v.deleted_at IS NULL
       UNION ALL
       SELECT c.id, 'knowledge_chunk'::text,
          c.document_id, c.document_version_id, c.usage_direction,
          c.source_page_start, NULL::text, NULL::text, c.content
         FROM knowledge_chunks c
         JOIN knowledge_documents d
           ON d.tenant_id = c.tenant_id AND d.id = c.document_id
         JOIN knowledge_document_versions v
           ON v.tenant_id = c.tenant_id AND v.id = c.document_version_id
        WHERE c.tenant_id = $1 AND c.knowledge_base_id = $2
          AND c.status = 'approved' AND d.status = 'ready'
          AND v.is_current = true AND v.status = 'ready' AND v.deleted_at IS NULL
       ORDER BY record_type, record_id`,
      [job.tenant_id, job.knowledge_base_id],
    );
    return result.rows;
  });
}

async function updateProgress(jobId, progress, contextRunner) {
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs SET progress = $2
      WHERE id = $1 AND status = 'running'`,
    [jobId, progress],
  ));
}

async function finishIndexJob(job, records, contextRunner) {
  return contextRunner(null, async (client) => {
    const state = await client.query(
      `SELECT status, publication_revision FROM knowledge_bases
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [job.tenant_id, job.knowledge_base_id],
    );
    if (!state.rowCount || state.rows[0].publication_revision !== job.targetRevision
      || !['published', 'partially_failed'].includes(state.rows[0].status)) {
      throw new AppError(409, 'Knowledge Base changed during semantic indexing', 'KNOWLEDGE_INDEX_STALE');
    }
    await client.query(
      `UPDATE faq_entries SET qdrant_point_id = NULL
        WHERE tenant_id = $1 AND knowledge_base_id = $2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    await client.query(
      `UPDATE knowledge_chunks SET qdrant_point_id = NULL
        WHERE tenant_id = $1 AND knowledge_base_id = $2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    const faqIds = records.filter((record) => record.record_type === 'faq').map((record) => record.record_id);
    const chunkIds = records.filter((record) => record.record_type === 'knowledge_chunk').map((record) => record.record_id);
    if (faqIds.length) {
      await client.query(
        `UPDATE faq_entries SET qdrant_point_id = id
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [job.tenant_id, faqIds],
      );
    }
    if (chunkIds.length) {
      await client.query(
        `UPDATE knowledge_chunks SET qdrant_point_id = id
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [job.tenant_id, chunkIds],
      );
    }
    const versionIds = [...new Set(records.map((record) => record.document_version_id))];
    if (versionIds.length) {
      await client.query(
        `UPDATE knowledge_document_versions
            SET embedding_model = $3, embedding_dimensions = $4
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [job.tenant_id, versionIds, env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS],
      );
    }
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'completed', progress = 100, completed_at = now(),
              error_code = NULL, error_message = NULL,
              metadata = metadata || $2::jsonb
        WHERE id = $1`,
      [job.id, JSON.stringify({ indexedRecordCount: records.length, collection: `tenant:${job.tenant_id}` })],
    );
    await client.query(
      `UPDATE knowledge_bases SET status = 'published'
        WHERE tenant_id = $1 AND id = $2 AND publication_revision = $3`,
      [job.tenant_id, job.knowledge_base_id, job.targetRevision],
    );
    return {
      jobId: job.id,
      tenantId: job.tenant_id,
      knowledgeBaseId: job.knowledge_base_id,
      publicationRevision: job.targetRevision,
      indexedRecordCount: records.length,
      status: 'completed',
    };
  });
}

async function failIndexJob(job, error, contextRunner) {
  const code = error instanceof AppError ? error.code : 'KNOWLEDGE_INDEX_FAILED';
  const message = String(error.message ?? 'Semantic indexing failed').slice(0, 4000);
  await contextRunner(null, async (client) => {
    await client.query(
      `UPDATE knowledge_processing_jobs
          SET status = 'failed', completed_at = now(), error_code = $2, error_message = $3
        WHERE id = $1 AND status <> 'completed'`,
      [job.id, code, message],
    );
    if (code === 'KNOWLEDGE_INDEX_STALE') return;
    await client.query(
      `UPDATE knowledge_bases SET status = 'partially_failed'
        WHERE tenant_id = $1 AND id = $2 AND publication_revision = $3
          AND status = 'published'`,
      [job.tenant_id, job.knowledge_base_id, job.targetRevision],
    );
  });
}

export async function processSemanticIndexJob(jobId, dependencies = defaultDependencies) {
  const runtime = { ...defaultDependencies, ...dependencies };
  const job = await claimIndexJob(jobId, runtime.contextRunner);
  if (job.alreadyCompleted) return { jobId, status: 'completed', skipped: true };
  if (job.stale) return { jobId, status: 'cancelled', stale: true };
  let qdrantMutated = false;
  try {
    const records = await loadSemanticRecords(job, runtime.contextRunner);
    await updateProgress(jobId, 15, runtime.contextRunner);
    const points = [];
    for (let start = 0; start < records.length; start += env.RAG_EMBEDDING_BATCH_SIZE) {
      const batch = records.slice(start, start + env.RAG_EMBEDDING_BATCH_SIZE);
      const vectors = await runtime.embed(batch.map((record) => embeddingText(record.content)));
      for (let index = 0; index < batch.length; index += 1) {
        const record = batch[index];
        const payload = tenantVectorPayload({
          tenantId: job.tenant_id,
          knowledgeBaseId: job.knowledge_base_id,
          documentId: record.document_id,
          documentVersionId: record.document_version_id,
          recordId: record.record_id,
          recordType: record.record_type,
          agentUsage: record.usage_direction.toUpperCase(),
          category: record.record_type,
          publicationRevision: job.targetRevision,
          content: record.content,
          ...(record.source_page_start ? { pageNumber: record.source_page_start } : {}),
        });
        points.push({
          id: record.record_id,
          vector: vectors[index],
          payload: {
            ...payload,
            ...(record.question ? { question: record.question, answer: record.answer } : {}),
          },
        });
      }
      const progress = 15 + Math.round(((start + batch.length) / Math.max(records.length, 1)) * 45);
      await updateProgress(jobId, progress, runtime.contextRunner);
    }

    await runtime.ensureCollection(job.tenant_id);
    await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id, {
      publicationRevision: job.targetRevision,
      revisionMode: 'equal',
    });
    qdrantMutated = true;
    for (let start = 0; start < points.length; start += env.QDRANT_UPSERT_BATCH_SIZE) {
      await runtime.upsertPoints(job.tenant_id, points.slice(start, start + env.QDRANT_UPSERT_BATCH_SIZE));
      const progress = 65 + Math.round(((start + Math.min(env.QDRANT_UPSERT_BATCH_SIZE, points.length - start))
        / Math.max(points.length, 1)) * 30);
      await updateProgress(jobId, progress, runtime.contextRunner);
    }
    await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id, {
      publicationRevision: job.targetRevision,
      revisionMode: 'older',
    });
    return await finishIndexJob(job, records, runtime.contextRunner);
  } catch (error) {
    if (qdrantMutated) {
      try {
        await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id, {
          publicationRevision: job.targetRevision,
          revisionMode: 'equal',
        });
      } catch (cleanupError) {
        error.qdrantCleanupError = cleanupError.message;
      }
    }
    await failIndexJob(job, error, runtime.contextRunner);
    throw error;
  }
}
