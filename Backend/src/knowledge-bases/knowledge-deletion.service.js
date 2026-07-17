import { logger } from '../config/logger.js';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { deleteAllB2ObjectVersions } from '../rag/b2.client.js';
import {
  deleteTenantPointsByDocument,
  deleteTenantPointsByKnowledgeBase,
} from '../rag/qdrant.client.js';
import { enqueueKnowledgeProcessingJob } from './knowledge-processing.queue.js';
import { invalidateTenantKnowledgeCache } from './knowledge-runtime.service.js';

const defaultProcessingDependencies = {
  contextRunner: withPlatformAdminContext,
  storage: { deleteAllVersions: deleteAllB2ObjectVersions },
  deleteDocumentPoints: deleteTenantPointsByDocument,
  deleteKnowledgeBasePoints: deleteTenantPointsByKnowledgeBase,
  queue: enqueueKnowledgeProcessingJob,
  invalidateCache: invalidateTenantKnowledgeCache,
};

async function enqueueDeletionJob(auth, job, contextRunner, queueAdapter) {
  try {
    const queued = await queueAdapter({ processingJobId: job.id, maxAttempts: job.maxAttempts });
    await contextRunner(auth, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id=$3,
          error_code=NULL, error_message=NULL WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, job.id, queued.id],
    ));
  } catch (error) {
    logger.warn({ err: error, processingJobId: job.id }, 'Knowledge deletion remains queued for reconciliation');
    await contextRunner(auth, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET error_code='QUEUE_UNAVAILABLE', error_message=$3
        WHERE tenant_id=$1 AND id=$2 AND status='queued'`,
      [auth.tenantId, job.id, String(error.message).slice(0, 4000)],
    )).catch(() => {});
  }
}

export async function requestDeleteKnowledgeDocument(
  auth,
  knowledgeBaseId,
  documentId,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
) {
  const result = await contextRunner(auth, async (client) => {
    const priorJob = await client.query(
      `SELECT j.id, j.max_attempts, j.status
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb ON kb.tenant_id=j.tenant_id AND kb.id=j.knowledge_base_id
        WHERE j.tenant_id=$1 AND j.knowledge_base_id=$2 AND j.document_id=$3
          AND j.job_type='delete_document' AND kb.workspace_id=$4
        ORDER BY j.created_at DESC LIMIT 1`,
      [auth.tenantId, knowledgeBaseId, documentId, auth.workspaceId],
    );
    if (priorJob.rowCount) {
      return {
        id: documentId, deleted: true,
        job: { id: priorJob.rows[0].id, maxAttempts: priorJob.rows[0].max_attempts },
        cleanupStatus: priorJob.rows[0].status,
        alreadyRequested: true,
      };
    }
    const document = await client.query(
      `SELECT d.id, d.display_name, d.status, kb.status AS knowledge_base_status,
          kb.publication_revision
         FROM knowledge_documents d
         JOIN knowledge_bases kb ON kb.tenant_id=d.tenant_id AND kb.id=d.knowledge_base_id
        WHERE d.tenant_id=$1 AND d.knowledge_base_id=$2 AND d.id=$3
          AND d.deleted_at IS NULL AND d.status <> 'deleted'
          AND kb.workspace_id=$4 AND kb.deleted_at IS NULL AND kb.status <> 'deleted'
        FOR UPDATE OF d, kb`,
      [auth.tenantId, knowledgeBaseId, documentId, auth.workspaceId],
    );
    if (!document.rowCount) throw new AppError(404, 'Knowledge document was not found', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
    const published = ['published', 'partially_failed'].includes(document.rows[0].knowledge_base_status);
    let reindexRevision = null;
    if (published) {
      reindexRevision = document.rows[0].publication_revision + 1;
      await client.query(
        `UPDATE knowledge_bases SET publication_revision=$3, status='published'
          WHERE tenant_id=$1 AND id=$2`,
        [auth.tenantId, knowledgeBaseId, reindexRevision],
      );
      await client.query(
        `UPDATE knowledge_processing_jobs SET status='cancelled', completed_at=now(),
            error_code='KNOWLEDGE_CONTENT_CHANGED', error_message='Document deleted during indexing'
          WHERE tenant_id=$1 AND knowledge_base_id=$2 AND job_type='index'
            AND status IN ('queued','running')`,
        [auth.tenantId, knowledgeBaseId],
      );
    }
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='cancelled', completed_at=now(),
          error_code='KNOWLEDGE_DOCUMENT_DELETED', error_message='Document was deleted'
        WHERE tenant_id=$1 AND document_id=$2 AND status IN ('queued','running')`,
      [auth.tenantId, documentId],
    );
    await client.query(
      `UPDATE knowledge_documents SET status='deleted', deleted_at=now(), updated_by=$3
        WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, documentId, auth.userId],
    );
    await client.query(
      `UPDATE knowledge_document_versions SET status='deleting', is_current=false
        WHERE tenant_id=$1 AND document_id=$2 AND status <> 'deleted'`,
      [auth.tenantId, documentId],
    );
    const job = await client.query(
      `INSERT INTO knowledge_processing_jobs (
         tenant_id, knowledge_base_id, document_id, job_type, status, queue_name, metadata
       ) VALUES ($1,$2,$3,'delete_document','queued','knowledge-processing',$4::jsonb)
       RETURNING id, max_attempts`,
      [
        auth.tenantId, knowledgeBaseId, documentId,
        JSON.stringify({ reindexRevision, displayName: document.rows[0].display_name }),
      ],
    );
    await client.query(
      `INSERT INTO audit_logs (
         tenant_id, workspace_id, actor_user_id, actor_type, action,
         entity_type, entity_id, before_data
       ) VALUES ($1,$2,$3,$4,'KNOWLEDGE_DOCUMENT_DELETE_REQUESTED',
         'knowledge_document',$5,$6::jsonb)`,
      [
        auth.tenantId, auth.workspaceId, auth.userId,
        auth.authType === 'api_key' ? 'api' : 'user', documentId,
        JSON.stringify({ knowledgeBaseId, displayName: document.rows[0].display_name }),
      ],
    );
    return {
      id: documentId,
      deleted: true,
      job: { id: job.rows[0].id, maxAttempts: job.rows[0].max_attempts },
      alreadyRequested: false,
    };
  });
  await invalidateTenantKnowledgeCache(auth.tenantId);
  if (!result.alreadyRequested) await enqueueDeletionJob(auth, result.job, contextRunner, queueAdapter);
  return {
    id: result.id,
    deleted: true,
    cleanupJob: { id: result.job.id, status: result.cleanupStatus ?? 'queued' },
  };
}

async function finalizeEmptyKnowledgeBase(client, auth, knowledgeBaseId) {
  await client.query('DELETE FROM agent_knowledge_bases WHERE tenant_id=$1 AND knowledge_base_id=$2', [auth.tenantId, knowledgeBaseId]);
  await client.query(
    `UPDATE knowledge_bases SET status='deleted', deleted_at=now(), updated_by=$3
      WHERE tenant_id=$1 AND id=$2`,
    [auth.tenantId, knowledgeBaseId, auth.userId],
  );
}

export async function requestDeleteKnowledgeBase(
  auth,
  knowledgeBaseId,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
) {
  const result = await contextRunner(auth, async (client) => {
    const priorJob = await client.query(
      `SELECT j.id, j.max_attempts, j.status
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb ON kb.tenant_id=j.tenant_id AND kb.id=j.knowledge_base_id
        WHERE j.tenant_id=$1 AND j.knowledge_base_id=$2
          AND j.job_type='delete_knowledge_base' AND kb.workspace_id=$3
        ORDER BY j.created_at DESC LIMIT 1`,
      [auth.tenantId, knowledgeBaseId, auth.workspaceId],
    );
    if (priorJob.rowCount) {
      return {
        id: knowledgeBaseId, deleted: true, immediate: false, alreadyRequested: true,
        cleanupStatus: priorJob.rows[0].status,
        job: { id: priorJob.rows[0].id, maxAttempts: priorJob.rows[0].max_attempts },
      };
    }
    const knowledgeBase = await client.query(
      `SELECT kb.*,
          (SELECT count(*)::int FROM knowledge_document_versions v
            WHERE v.tenant_id=kb.tenant_id AND v.knowledge_base_id=kb.id
              AND v.deleted_at IS NULL) AS version_count
        FROM knowledge_bases kb
        WHERE kb.tenant_id=$1 AND kb.workspace_id=$2 AND kb.id=$3 FOR UPDATE`,
      [auth.tenantId, auth.workspaceId, knowledgeBaseId],
    );
    if (!knowledgeBase.rowCount) throw new AppError(404, 'Knowledge Base was not found', 'KNOWLEDGE_BASE_NOT_FOUND');
    const row = knowledgeBase.rows[0];
    if (row.status === 'deleted') {
      return { id: knowledgeBaseId, deleted: true, immediate: true, alreadyRequested: true };
    }
    await client.query(
      `INSERT INTO audit_logs (
         tenant_id, workspace_id, actor_user_id, actor_type, action,
         entity_type, entity_id, before_data
       ) VALUES ($1,$2,$3,$4,'KNOWLEDGE_BASE_DELETE_REQUESTED','knowledge_base',$5,$6::jsonb)`,
      [
        auth.tenantId, auth.workspaceId, auth.userId,
        auth.authType === 'api_key' ? 'api' : 'user', knowledgeBaseId,
        JSON.stringify({ name: row.name, documentCount: row.version_count }),
      ],
    );
    if (row.version_count === 0 && row.publication_revision === 0) {
      await finalizeEmptyKnowledgeBase(client, auth, knowledgeBaseId);
      return { id: knowledgeBaseId, deleted: true, immediate: true };
    }
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='cancelled', completed_at=now(),
          error_code='KNOWLEDGE_BASE_DELETED', error_message='Knowledge Base was deleted'
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status IN ('queued','running')`,
      [auth.tenantId, knowledgeBaseId],
    );
    await client.query(
      `UPDATE knowledge_bases SET status='deleted', deleted_at=now(), updated_by=$3
        WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, knowledgeBaseId, auth.userId],
    );
    await client.query(
      `UPDATE knowledge_documents SET status='deleting'
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status <> 'deleted'`,
      [auth.tenantId, knowledgeBaseId],
    );
    await client.query(
      `UPDATE knowledge_document_versions SET status='deleting', is_current=false
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status <> 'deleted'`,
      [auth.tenantId, knowledgeBaseId],
    );
    await client.query('DELETE FROM agent_knowledge_bases WHERE tenant_id=$1 AND knowledge_base_id=$2', [auth.tenantId, knowledgeBaseId]);
    const job = await client.query(
      `INSERT INTO knowledge_processing_jobs (
         tenant_id, knowledge_base_id, job_type, status, queue_name, metadata
       ) VALUES ($1,$2,'delete_knowledge_base','queued','knowledge-processing',$3::jsonb)
       RETURNING id, max_attempts`,
      [auth.tenantId, knowledgeBaseId, JSON.stringify({ name: row.name })],
    );
    return {
      id: knowledgeBaseId,
      deleted: true,
      immediate: false,
      job: { id: job.rows[0].id, maxAttempts: job.rows[0].max_attempts },
    };
  });
  await invalidateTenantKnowledgeCache(auth.tenantId);
  if (!result.immediate && !result.alreadyRequested) {
    await enqueueDeletionJob(auth, result.job, contextRunner, queueAdapter);
  }
  return {
    id: knowledgeBaseId,
    deleted: true,
    ...(result.immediate
      ? { cleanupCompleted: true }
      : { cleanupJob: { id: result.job.id, status: result.cleanupStatus ?? 'queued' } }),
  };
}

async function claimDeletionJob(jobId, contextRunner) {
  return contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_processing_jobs
        WHERE id=$1 AND job_type IN ('delete_document','delete_knowledge_base') FOR UPDATE`,
      [jobId],
    );
    if (!result.rowCount) throw new AppError(404, 'Knowledge deletion job was not found', 'KNOWLEDGE_DELETE_JOB_NOT_FOUND');
    const job = result.rows[0];
    if (job.status === 'completed') return { ...job, alreadyCompleted: true };
    if (job.attempt_count >= job.max_attempts) {
      throw new AppError(409, 'Knowledge deletion exhausted its retries', 'KNOWLEDGE_DELETE_RETRIES_EXHAUSTED');
    }
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='running', progress=10,
          attempt_count=attempt_count+1, started_at=now(), completed_at=NULL,
          error_code=NULL, error_message=NULL WHERE id=$1`,
      [jobId],
    );
    const versions = await client.query(
      `SELECT id, b2_object_key, extracted_text_object_key
         FROM knowledge_document_versions
        WHERE tenant_id=$1 AND knowledge_base_id=$2
          AND ($3::uuid IS NULL OR document_id=$3)`,
      [job.tenant_id, job.knowledge_base_id, job.document_id],
    );
    return { ...job, versions: versions.rows, attempt_count: job.attempt_count + 1 };
  });
}

async function deleteContentRecords(client, job) {
  const condition = job.job_type === 'delete_document'
    ? 'knowledge_base_id=$2 AND document_id=$3'
    : 'knowledge_base_id=$2';
  const values = job.job_type === 'delete_document'
    ? [job.tenant_id, job.knowledge_base_id, job.document_id]
    : [job.tenant_id, job.knowledge_base_id];
  for (const table of ['faq_entries', 'structured_catalogs', 'workflow_rules', 'conversation_flows', 'knowledge_chunks']) {
    await client.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND ${condition}`, values);
  }
}

async function finishDeletion(job, contextRunner) {
  return contextRunner(null, async (client) => {
    await deleteContentRecords(client, job);
    if (job.job_type === 'delete_document') {
      await client.query(
        `UPDATE knowledge_document_versions SET status='deleted', deleted_at=now(), is_current=false
          WHERE tenant_id=$1 AND document_id=$2`,
        [job.tenant_id, job.document_id],
      );
      await client.query(
        `UPDATE knowledge_documents SET status='deleted', deleted_at=COALESCE(deleted_at,now())
          WHERE tenant_id=$1 AND id=$2`,
        [job.tenant_id, job.document_id],
      );
      const revision = Number(job.metadata?.reindexRevision);
      let indexJob = null;
      if (Number.isInteger(revision) && revision > 0) {
        const created = await client.query(
          `INSERT INTO knowledge_processing_jobs (
             tenant_id, knowledge_base_id, job_type, status, queue_name, metadata
           ) VALUES ($1,$2,'index','queued','knowledge-processing',$3::jsonb)
           RETURNING id, max_attempts`,
          [job.tenant_id, job.knowledge_base_id, JSON.stringify({ publicationRevision: revision })],
        );
        indexJob = { id: created.rows[0].id, maxAttempts: created.rows[0].max_attempts };
      } else {
        await client.query(
          `UPDATE knowledge_bases kb SET status=CASE
             WHEN EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.tenant_id=kb.tenant_id
               AND d.knowledge_base_id=kb.id AND d.deleted_at IS NULL AND d.status='failed')
               THEN 'partially_failed'::knowledge_base_status
             WHEN EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.tenant_id=kb.tenant_id
               AND d.knowledge_base_id=kb.id AND d.deleted_at IS NULL
               AND d.status IN ('uploading','queued','processing')) THEN 'processing'::knowledge_base_status
             ELSE 'ready'::knowledge_base_status END
           WHERE kb.tenant_id=$1 AND kb.id=$2 AND kb.status <> 'deleted'`,
          [job.tenant_id, job.knowledge_base_id],
        );
      }
      await client.query(
        `UPDATE knowledge_processing_jobs SET status='completed', progress=100,
            completed_at=now(), error_code=NULL, error_message=NULL WHERE id=$1`,
        [job.id],
      );
      return { indexJob };
    }
    await client.query(
      `UPDATE knowledge_document_versions SET status='deleted', deleted_at=now(), is_current=false
        WHERE tenant_id=$1 AND knowledge_base_id=$2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    await client.query(
      `UPDATE knowledge_documents SET status='deleted', deleted_at=COALESCE(deleted_at,now())
        WHERE tenant_id=$1 AND knowledge_base_id=$2`,
      [job.tenant_id, job.knowledge_base_id],
    );
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='completed', progress=100,
          completed_at=now(), error_code=NULL, error_message=NULL WHERE id=$1`,
      [job.id],
    );
    return { indexJob: null };
  });
}

async function failDeletion(job, error, contextRunner) {
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs SET status='failed', completed_at=now(),
        error_code='KNOWLEDGE_DELETE_FAILED', error_message=$2 WHERE id=$1 AND status <> 'completed'`,
    [job.id, String(error.message ?? 'Knowledge deletion failed').slice(0, 4000)],
  ));
}

export async function processKnowledgeDeletionJob(jobId, dependencies = defaultProcessingDependencies) {
  const runtime = {
    ...defaultProcessingDependencies,
    ...dependencies,
    storage: { ...defaultProcessingDependencies.storage, ...dependencies.storage },
  };
  const job = await claimDeletionJob(jobId, runtime.contextRunner);
  if (job.alreadyCompleted) return { jobId, status: 'completed', skipped: true };
  try {
    if (job.job_type === 'delete_document') {
      await runtime.deleteDocumentPoints(job.tenant_id, job.document_id);
    } else {
      await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id);
    }
    for (const version of job.versions) {
      await runtime.storage.deleteAllVersions({ key: version.b2_object_key });
      if (version.extracted_text_object_key) {
        await runtime.storage.deleteAllVersions({ key: version.extracted_text_object_key });
      }
    }
    const finished = await finishDeletion(job, runtime.contextRunner);
    if (finished.indexJob) {
      try {
        const queued = await runtime.queue({
          processingJobId: finished.indexJob.id,
          maxAttempts: finished.indexJob.maxAttempts,
        });
        await runtime.contextRunner(null, (client) => client.query(
          'UPDATE knowledge_processing_jobs SET bullmq_job_id=$2 WHERE id=$1',
          [finished.indexJob.id, queued.id],
        ));
      } catch (error) {
        logger.warn({ err: error, processingJobId: finished.indexJob.id }, 'Deletion reindex remains queued');
      }
    }
    await runtime.invalidateCache(job.tenant_id);
    return {
      jobId,
      status: 'completed',
      deletedVersionCount: job.versions.length,
      reindexJobId: finished.indexJob?.id ?? null,
    };
  } catch (error) {
    await failDeletion(job, error, runtime.contextRunner);
    throw error;
  }
}
