import { createHash } from 'node:crypto';
import { logger } from '../config/logger.js';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import {
  deleteAllB2ObjectsUnderPrefix,
  deleteAllB2ObjectsUnderDocumentPrefix,
  knowledgeBaseB2Prefix,
  knowledgeDocumentB2Prefix,
} from '../rag/b2.client.js';
import {
  deleteTenantPointsByDocument,
  deleteTenantPointsByKnowledgeBase,
} from '../rag/qdrant.client.js';
import {
  enqueueKnowledgeProcessingJob,
  permanentKnowledgeDeletionAttempts,
  removeKnowledgeProcessingQueueJobs,
} from './knowledge-processing.queue.js';
import { invalidateTenantKnowledgeCache } from './knowledge-runtime.service.js';

const defaultProcessingDependencies = {
  contextRunner: withPlatformAdminContext,
  storage: {
    deletePrefix: deleteAllB2ObjectsUnderPrefix,
    deleteDocumentPrefix: deleteAllB2ObjectsUnderDocumentPrefix,
  },
  deleteDocumentPoints: deleteTenantPointsByDocument,
  deleteKnowledgeBasePoints: deleteTenantPointsByKnowledgeBase,
  queue: enqueueKnowledgeProcessingJob,
  removeQueueJobs: removeKnowledgeProcessingQueueJobs,
  invalidateCache: invalidateTenantKnowledgeCache,
};

const runtimeProfileDrainGraceMs = 30_000;

const knowledgeCascadeTables = [
  'knowledge_bases',
  'knowledge_documents',
  'knowledge_document_versions',
  'knowledge_processing_jobs',
  'faq_entries',
  'structured_catalogs',
  'structured_items',
  'structured_item_attributes',
  'workflow_rules',
  'conversation_flows',
  'knowledge_chunks',
  'agent_knowledge_bases',
];

const knowledgeCascadeChildren = knowledgeCascadeTables.filter((table) => table !== 'knowledge_bases');

const documentCascadeTables = [
  'knowledge_documents',
  'knowledge_document_versions',
  'knowledge_processing_jobs',
  'faq_entries',
  'structured_catalogs',
  'structured_items',
  'structured_item_attributes',
  'workflow_rules',
  'conversation_flows',
  'knowledge_chunks',
];

const documentCascadeChildren = documentCascadeTables.filter((table) => table !== 'knowledge_documents');

async function verifyCascadeContract(client, { tables, rootTable, children, errorCode, label }) {
  const constraints = await client.query(
    `SELECT child.relname AS child_table, parent.relname AS parent_table,
            constraint_record.conname AS constraint_name,
            constraint_record.confdeltype AS delete_action
       FROM pg_constraint constraint_record
       JOIN pg_class child ON child.oid=constraint_record.conrelid
       JOIN pg_class parent ON parent.oid=constraint_record.confrelid
       JOIN pg_namespace child_namespace ON child_namespace.oid=child.relnamespace
       JOIN pg_namespace parent_namespace ON parent_namespace.oid=parent.relnamespace
      WHERE constraint_record.contype='f'
        AND child_namespace.nspname=current_schema()
        AND parent_namespace.nspname=current_schema()
        AND child.relname=ANY($1::text[])
        AND parent.relname=ANY($1::text[])`,
    [tables],
  );
  const cascadeParents = new Map();
  const unsafeConstraints = [];
  for (const row of constraints.rows) {
    if (row.delete_action !== 'c') {
      unsafeConstraints.push({
        table: row.child_table,
        parent: row.parent_table,
        constraint: row.constraint_name,
        deleteAction: row.delete_action,
      });
      continue;
    }
    const parents = cascadeParents.get(row.child_table) ?? new Set();
    parents.add(row.parent_table);
    cascadeParents.set(row.child_table, parents);
  }
  const reachesRoot = (table, visited = new Set()) => {
    if (table === rootTable) return true;
    if (visited.has(table)) return false;
    const nextVisited = new Set(visited).add(table);
    return [...(cascadeParents.get(table) ?? [])].some((parent) => reachesRoot(parent, nextVisited));
  };
  const missingCascadePaths = children.filter((table) => !reachesRoot(table));
  if (missingCascadePaths.length || unsafeConstraints.length) {
    throw new AppError(
      500,
      `PostgreSQL ${label} cascade contract is unsafe; permanent deletion was stopped`,
      errorCode,
      { missingCascadePaths, unsafeConstraints },
    );
  }
  return { verified: true, tables: [...tables], constraintCount: constraints.rowCount };
}

export async function verifyKnowledgeBaseCascadeContract(client) {
  return verifyCascadeContract(client, {
    tables: knowledgeCascadeTables,
    rootTable: 'knowledge_bases',
    children: knowledgeCascadeChildren,
    errorCode: 'KNOWLEDGE_DELETE_CASCADE_UNSAFE',
    label: 'Knowledge Base',
  });
}

export async function verifyKnowledgeDocumentCascadeContract(client) {
  return verifyCascadeContract(client, {
    tables: documentCascadeTables,
    rootTable: 'knowledge_documents',
    children: documentCascadeChildren,
    errorCode: 'KNOWLEDGE_DOCUMENT_DELETE_CASCADE_UNSAFE',
    label: 'Knowledge document',
  });
}

async function verifyKnowledgeDocumentRowsRemoved(client, tenantId, knowledgeBaseId, documentId) {
  const counts = await client.query(
    `SELECT table_name, remaining_count FROM (
       SELECT 'knowledge_documents'::text AS table_name, count(*)::int AS remaining_count
         FROM knowledge_documents WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id=$3
       UNION ALL SELECT 'knowledge_document_versions', count(*)::int
         FROM knowledge_document_versions WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'knowledge_processing_jobs', count(*)::int
         FROM knowledge_processing_jobs WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'faq_entries', count(*)::int
         FROM faq_entries WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'structured_catalogs', count(*)::int
         FROM structured_catalogs WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'structured_items', count(*)::int
         FROM structured_items WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'structured_item_attributes', count(*)::int
         FROM structured_item_attributes WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'workflow_rules', count(*)::int
         FROM workflow_rules WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'conversation_flows', count(*)::int
         FROM conversation_flows WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
       UNION ALL SELECT 'knowledge_chunks', count(*)::int
         FROM knowledge_chunks WHERE tenant_id=$1 AND knowledge_base_id=$2 AND document_id=$3
     ) document_cascade_verification
     ORDER BY table_name`,
    [tenantId, knowledgeBaseId, documentId],
  );
  const remaining = counts.rows.filter((row) => Number(row.remaining_count) !== 0);
  if (remaining.length) {
    throw new AppError(
      500,
      'PostgreSQL Knowledge document cascade left related records; transaction was rolled back',
      'KNOWLEDGE_DOCUMENT_DELETE_POSTGRES_INCOMPLETE',
      { remaining },
    );
  }
  return { verified: true, tables: counts.rows.map((row) => row.table_name) };
}

async function hardDeleteKnowledgeDocumentInTransaction(client, job) {
  const cascadeContract = await verifyKnowledgeDocumentCascadeContract(client);
  const deleted = await client.query(
    `DELETE FROM knowledge_documents
      WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id=$3 AND status='deleting'
      RETURNING id`,
    [job.tenant_id, job.knowledge_base_id, job.document_id],
  );
  if (!deleted.rowCount) {
    throw new AppError(404, 'Knowledge document was not found during permanent cleanup', 'KNOWLEDGE_DOCUMENT_NOT_FOUND');
  }
  const cascadeCleanup = await verifyKnowledgeDocumentRowsRemoved(
    client, job.tenant_id, job.knowledge_base_id, job.document_id,
  );
  return { deleted: true, cascadeContract, cascadeCleanup };
}

async function verifyKnowledgeBaseRowsRemoved(client, tenantId, knowledgeBaseId) {
  const counts = await client.query(
    `SELECT table_name, remaining_count FROM (
       SELECT 'knowledge_bases'::text AS table_name, count(*)::int AS remaining_count
         FROM knowledge_bases WHERE tenant_id=$1 AND id=$2
       UNION ALL SELECT 'knowledge_documents', count(*)::int
         FROM knowledge_documents WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'knowledge_document_versions', count(*)::int
         FROM knowledge_document_versions WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'knowledge_processing_jobs', count(*)::int
         FROM knowledge_processing_jobs WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'faq_entries', count(*)::int
         FROM faq_entries WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'structured_catalogs', count(*)::int
         FROM structured_catalogs WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'structured_items', count(*)::int
         FROM structured_items WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'structured_item_attributes', count(*)::int
         FROM structured_item_attributes WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'workflow_rules', count(*)::int
         FROM workflow_rules WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'conversation_flows', count(*)::int
         FROM conversation_flows WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'knowledge_chunks', count(*)::int
         FROM knowledge_chunks WHERE tenant_id=$1 AND knowledge_base_id=$2
       UNION ALL SELECT 'agent_knowledge_bases', count(*)::int
         FROM agent_knowledge_bases WHERE tenant_id=$1 AND knowledge_base_id=$2
     ) cascade_verification
     ORDER BY table_name`,
    [tenantId, knowledgeBaseId],
  );
  const remaining = counts.rows.filter((row) => Number(row.remaining_count) !== 0);
  if (remaining.length) {
    throw new AppError(
      500,
      'PostgreSQL Knowledge Base cascade left related records; transaction was rolled back',
      'KNOWLEDGE_DELETE_POSTGRES_INCOMPLETE',
      { remaining },
    );
  }
  return { verified: true, tables: counts.rows.map((row) => row.table_name) };
}

export async function cleanHistoricalKnowledgeBaseReferences(client, tenantId, knowledgeBaseId) {
  const transcriptCleanup = await client.query(
    `UPDATE call_transcript_entries transcript
        SET sources=COALESCE((
          SELECT jsonb_agg(source.value ORDER BY source.ordinality)
            FROM jsonb_array_elements(transcript.sources) WITH ORDINALITY AS source(value, ordinality)
           WHERE NOT (
             source.value->>'type'='knowledge'
             AND jsonb_path_exists(
               source.value,
               '$.** ? (@ == $knowledgeBaseId)',
               jsonb_build_object('knowledgeBaseId', to_jsonb($2::text))
             )
           )
        ), '[]'::jsonb)
      WHERE transcript.tenant_id=$1
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(transcript.sources) AS source(value)
           WHERE source.value->>'type'='knowledge'
             AND jsonb_path_exists(
               source.value,
               '$.** ? (@ == $knowledgeBaseId)',
               jsonb_build_object('knowledgeBaseId', to_jsonb($2::text))
             )
        )
      RETURNING transcript.id`,
    [tenantId, knowledgeBaseId],
  );

  const auditCleanup = await client.query(
    `DELETE FROM audit_logs audit
      WHERE audit.tenant_id=$1
        AND (
          (audit.entity_type IN ('knowledge_base','agent_knowledge_base') AND audit.entity_id=$2::text)
          OR (audit.entity_type='knowledge_document' AND audit.entity_id IN (
            SELECT document.id::text FROM knowledge_documents document
             WHERE document.tenant_id=$1::uuid AND document.knowledge_base_id=$2::uuid
          ))
          OR (audit.entity_type='knowledge_document_version' AND audit.entity_id IN (
            SELECT version.id::text FROM knowledge_document_versions version
             WHERE version.tenant_id=$1::uuid AND version.knowledge_base_id=$2::uuid
          ))
          OR (audit.entity_type='knowledge_review_record' AND audit.entity_id IN (
            SELECT record_id FROM (
              SELECT id::text AS record_id FROM faq_entries
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
              UNION ALL SELECT id::text FROM structured_catalogs
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
              UNION ALL SELECT id::text FROM structured_items
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
              UNION ALL SELECT id::text FROM structured_item_attributes
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
              UNION ALL SELECT id::text FROM workflow_rules
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
              UNION ALL SELECT id::text FROM conversation_flows
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
              UNION ALL SELECT id::text FROM knowledge_chunks
                WHERE tenant_id=$1::uuid AND knowledge_base_id=$2::uuid
            ) knowledge_record_ids
          ))
          OR (
            (audit.action LIKE 'KNOWLEDGE_%' OR audit.action LIKE 'AGENT_KNOWLEDGE_%')
            AND (
              jsonb_path_exists(COALESCE(audit.before_data, '{}'::jsonb), '$.** ? (@ == $knowledgeBaseId)',
                jsonb_build_object('knowledgeBaseId', to_jsonb($2::text)))
              OR jsonb_path_exists(COALESCE(audit.after_data, '{}'::jsonb), '$.** ? (@ == $knowledgeBaseId)',
                jsonb_build_object('knowledgeBaseId', to_jsonb($2::text)))
              OR jsonb_path_exists(COALESCE(audit.metadata, '{}'::jsonb), '$.** ? (@ == $knowledgeBaseId)',
                jsonb_build_object('knowledgeBaseId', to_jsonb($2::text)))
            )
          )
        )
      RETURNING audit.id`,
    [tenantId, knowledgeBaseId],
  );

  return {
    transcriptEntriesUpdated: transcriptCleanup.rowCount,
    auditRecordsDeleted: auditCleanup.rowCount,
  };
}

async function hardDeleteKnowledgeBaseInTransaction(client, {
  tenantId, knowledgeBaseId, requiredStatus, requireSoftDeleted = false,
}) {
  const cascadeContract = await verifyKnowledgeBaseCascadeContract(client);
  const historicalReferences = await cleanHistoricalKnowledgeBaseReferences(client, tenantId, knowledgeBaseId);
  const statusCondition = requireSoftDeleted
    ? " AND (status='deleted' OR deleted_at IS NOT NULL)"
    : requiredStatus ? ' AND status=$3' : '';
  const values = requiredStatus && !requireSoftDeleted
    ? [tenantId, knowledgeBaseId, requiredStatus]
    : [tenantId, knowledgeBaseId];
  const deleted = await client.query(
    `DELETE FROM knowledge_bases
      WHERE tenant_id=$1 AND id=$2${statusCondition}
      RETURNING id`,
    values,
  );
  if (!deleted.rowCount) return { deleted: false, cascadeContract, historicalReferences };
  const cascadeCleanup = await verifyKnowledgeBaseRowsRemoved(client, tenantId, knowledgeBaseId);
  return { deleted: true, cascadeContract, cascadeCleanup, historicalReferences };
}

async function enqueueDeletionJob(auth, job, contextRunner, queueAdapter) {
  try {
    const queued = await queueAdapter({
      processingJobId: job.id,
      maxAttempts: job.maxAttempts,
      removeOnComplete: true,
      permanentDeletion: true,
    });
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
    const published = document.rows[0].knowledge_base_status === 'published';
    let reindexRevision = null;
    if (published) {
      reindexRevision = document.rows[0].publication_revision + 1;
      await client.query(
        `UPDATE knowledge_bases SET pending_publication_revision=$3, status='processing',
            published_at=NULL, published_by=NULL
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
    } else {
      await client.query(
        `UPDATE knowledge_bases SET status='processing', pending_publication_revision=NULL,
            published_at=NULL, published_by=NULL
          WHERE tenant_id=$1 AND id=$2`,
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
      `UPDATE knowledge_documents SET status='deleting', deleted_at=NULL, updated_by=$3
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
         tenant_id, knowledge_base_id, document_id, job_type, status, queue_name, metadata, max_attempts
       ) VALUES ($1,$2,$3,'delete_document','queued','knowledge-processing',$4::jsonb,$5)
       RETURNING id, max_attempts`,
      [
        auth.tenantId, knowledgeBaseId, documentId,
        JSON.stringify({ reindexRevision, displayName: document.rows[0].display_name }),
        permanentKnowledgeDeletionAttempts,
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

export async function requestDeleteKnowledgeBase(
  auth,
  knowledgeBaseId,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
  queueRemovalAdapter = removeKnowledgeProcessingQueueJobs,
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
    if (row.status === 'deleted') throw new AppError(
      409,
      'Knowledge Base is already awaiting permanent cleanup',
      'KNOWLEDGE_BASE_DELETE_ALREADY_REQUESTED',
    );
    const assignments = await client.query(
      `SELECT agent_id FROM agent_knowledge_bases
        WHERE tenant_id=$1 AND knowledge_base_id=$2`,
      [auth.tenantId, knowledgeBaseId],
    );
    const relatedQueueJobs = await client.query(
      `SELECT id, bullmq_job_id FROM knowledge_processing_jobs
        WHERE tenant_id=$1 AND knowledge_base_id=$2`,
      [auth.tenantId, knowledgeBaseId],
    );
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
    await client.query(
      `UPDATE knowledge_processing_jobs SET status='cancelled', completed_at=now(),
          error_code='KNOWLEDGE_BASE_DELETED', error_message='Knowledge Base was deleted'
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND status IN ('queued','running')`,
      [auth.tenantId, knowledgeBaseId],
    );
    await client.query(
      `UPDATE knowledge_bases SET status='deleting', deleted_at=NULL, updated_by=$3
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
         tenant_id, knowledge_base_id, job_type, status, queue_name, metadata, max_attempts
       ) VALUES ($1,$2,'delete_knowledge_base','queued','knowledge-processing',$3::jsonb,$4)
       RETURNING id, max_attempts`,
      [auth.tenantId, knowledgeBaseId, JSON.stringify({
        name: row.name,
        assignedAgentIds: assignments.rows.map((assignment) => assignment.agent_id),
        runtimeProfileDrainNotBefore: new Date(Date.now() + runtimeProfileDrainGraceMs).toISOString(),
      }), permanentKnowledgeDeletionAttempts],
    );
    return {
      id: knowledgeBaseId,
      deleted: true,
      immediate: false,
      job: {
        id: job.rows[0].id,
        maxAttempts: job.rows[0].max_attempts,
        permanent: true,
      },
      relatedQueueJobIds: [...new Set(relatedQueueJobs.rows.flatMap(
        (item) => [item.id, item.bullmq_job_id].filter(Boolean).map(String),
      ))],
    };
  });
  await invalidateTenantKnowledgeCache(auth.tenantId);
  if (!result.alreadyRequested) {
    try {
      await queueRemovalAdapter(result.relatedQueueJobIds);
    } catch (error) {
      logger.warn({ err: error, knowledgeBaseId }, 'Queued Knowledge Base work will be removed by permanent cleanup retry');
    }
    await enqueueDeletionJob(auth, result.job, contextRunner, queueAdapter);
  }
  return {
    id: knowledgeBaseId,
    deleted: true,
    permanent: true,
    cleanupJob: { id: result.job.id, status: result.cleanupStatus ?? 'queued' },
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
    if (job.job_type === 'delete_knowledge_base') {
      const drainNotBefore = Date.parse(job.metadata?.runtimeProfileDrainNotBefore ?? '');
      const assignedAgentIds = Array.isArray(job.metadata?.assignedAgentIds)
        ? job.metadata.assignedAgentIds.filter(Boolean)
        : [];
      const activeCalls = await client.query(
        `SELECT id FROM call_sessions
          WHERE tenant_id=$1 AND status='connected' AND ended_at IS NULL
            AND (
              COALESCE(provider_metadata #> '{knowledgeSnapshot,knowledgeBaseIds}','[]'::jsonb) ? $2
              OR agent_id = ANY($3::uuid[])
            )
          ORDER BY started_at, id
          LIMIT 100`,
        [job.tenant_id, job.knowledge_base_id, assignedAgentIds],
      );
      const graceActive = Number.isFinite(drainNotBefore) && Date.now() < drainNotBefore;
      if (graceActive || activeCalls.rowCount > 0) {
        const reason = graceActive
          ? 'Waiting for in-flight runtime profiles to register'
          : `Waiting for ${activeCalls.rowCount} active call(s) to finish`;
        await client.query(
          `UPDATE knowledge_processing_jobs SET status='queued', progress=5,
              started_at=NULL, completed_at=NULL, error_code='KNOWLEDGE_DELETE_ACTIVE_CALLS',
              error_message=$2 WHERE id=$1`,
          [jobId, reason],
        );
        return { ...job, deferred: true, activeCallCount: activeCalls.rowCount, deferReason: reason };
      }
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
    const queueJobs = await client.query(
      `SELECT id, bullmq_job_id
         FROM knowledge_processing_jobs
        WHERE tenant_id=$1 AND knowledge_base_id=$2 AND id<>$3
          AND (
            $4::uuid IS NULL
            OR document_id=$4
            OR (job_type='index' AND status='cancelled')
          )
        `,
      [job.tenant_id, job.knowledge_base_id, job.id, job.document_id],
    );
    return {
      ...job,
      versions: versions.rows,
      storagePrefix: knowledgeBaseB2Prefix({
        tenantId: job.tenant_id,
        knowledgeBaseId: job.knowledge_base_id,
      }),
      documentStoragePrefix: job.document_id ? knowledgeDocumentB2Prefix({
        tenantId: job.tenant_id,
        knowledgeBaseId: job.knowledge_base_id,
        documentId: job.document_id,
      }) : null,
      relatedQueueJobIds: [...new Set(queueJobs.rows.flatMap(
        (row) => [row.id, row.bullmq_job_id].filter(Boolean).map(String),
      ))],
      attempt_count: job.attempt_count + 1,
    };
  });
}

async function finishDeletion(job, contextRunner) {
  return contextRunner(null, async (client) => {
    if (job.job_type === 'delete_document') {
      const postgresCleanup = await hardDeleteKnowledgeDocumentInTransaction(client, job);
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
      return { indexJob, permanentlyDeleted: true, postgresCleanup };
    }
    const postgresCleanup = await hardDeleteKnowledgeBaseInTransaction(client, {
      tenantId: job.tenant_id,
      knowledgeBaseId: job.knowledge_base_id,
    });
    if (!postgresCleanup.deleted) {
      throw new AppError(404, 'Knowledge Base was not found during permanent cleanup', 'KNOWLEDGE_BASE_NOT_FOUND');
    }
    return { indexJob: null, permanentlyDeleted: true, postgresCleanup };
  });
}

async function failDeletion(job, error, contextRunner, errorCode = 'KNOWLEDGE_DELETE_FAILED') {
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs SET status='failed', completed_at=now(),
        error_code=$2, error_message=$3 WHERE id=$1 AND status <> 'completed'`,
    [job.id, errorCode, String(error.message ?? 'Knowledge deletion failed').slice(0, 4000)],
  ));
}

async function queueDeletionRetry(job, error, contextRunner, errorCode = 'KNOWLEDGE_DELETE_RETRY') {
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs SET status='queued', progress=5,
        started_at=NULL, completed_at=NULL, error_code=$2, error_message=$3
      WHERE id=$1 AND status <> 'completed'`,
    [
      job.id,
      errorCode,
      String(error.message ?? 'Knowledge deletion will retry').slice(0, 4000),
    ],
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
  if (job.deferred) {
    throw new AppError(
      409,
      job.deferReason,
      'KNOWLEDGE_DELETE_ACTIVE_CALLS',
      { activeCallCount: job.activeCallCount },
    );
  }
  let cleanupStage = 'BULLMQ';
  try {
    const queueCleanup = await runtime.removeQueueJobs(job.relatedQueueJobIds);
    if (queueCleanup.active.length) {
      throw new AppError(
        409,
        'Related Knowledge processing is still stopping; permanent cleanup will retry',
        'KNOWLEDGE_DELETE_QUEUE_BUSY',
      );
    }
    if (queueCleanup.verified !== true || queueCleanup.remaining?.length) {
      throw new AppError(503, 'BullMQ Knowledge cleanup could not be verified', 'KNOWLEDGE_DELETE_QUEUE_UNVERIFIED');
    }
    cleanupStage = 'QDRANT';
    let qdrantCleanup;
    if (job.job_type === 'delete_document') {
      qdrantCleanup = await runtime.deleteDocumentPoints(job.tenant_id, job.document_id, {
        knowledgeBaseId: job.knowledge_base_id,
      });
      if (qdrantCleanup?.verified !== true || qdrantCleanup?.remainingCount !== 0) {
        throw new AppError(503, 'Qdrant document cleanup could not be verified', 'KNOWLEDGE_DELETE_QDRANT_UNVERIFIED');
      }
    } else {
      qdrantCleanup = await runtime.deleteKnowledgeBasePoints(job.tenant_id, job.knowledge_base_id);
      if (qdrantCleanup?.verified !== true || qdrantCleanup?.remainingCount !== 0) {
        throw new AppError(503, 'Qdrant Knowledge Base cleanup could not be verified', 'KNOWLEDGE_DELETE_QDRANT_UNVERIFIED');
      }
    }
    cleanupStage = 'B2';
    let storageCleanup;
    if (job.job_type === 'delete_knowledge_base') {
      storageCleanup = await runtime.storage.deletePrefix({
        prefix: job.storagePrefix,
        tenantId: job.tenant_id,
        knowledgeBaseId: job.knowledge_base_id,
      });
      if (storageCleanup?.verified !== true || storageCleanup?.remainingObjectVersions !== 0) {
        throw new AppError(503, 'B2 Knowledge Base cleanup could not be verified', 'KNOWLEDGE_DELETE_B2_UNVERIFIED');
      }
    } else {
      storageCleanup = await runtime.storage.deleteDocumentPrefix({
        prefix: job.documentStoragePrefix,
        tenantId: job.tenant_id,
        knowledgeBaseId: job.knowledge_base_id,
        documentId: job.document_id,
      });
      if (storageCleanup?.verified !== true || storageCleanup?.remainingObjectVersions !== 0) {
        throw new AppError(503, 'B2 document cleanup could not be verified', 'KNOWLEDGE_DELETE_B2_UNVERIFIED');
      }
    }
    cleanupStage = 'REDIS';
    const cacheCleanup = await runtime.invalidateCache(job.tenant_id);
    if (cacheCleanup?.incomplete) {
      throw new AppError(503, 'Knowledge Base cache cleanup was incomplete', 'KNOWLEDGE_DELETE_CACHE_INCOMPLETE');
    }
    if (cacheCleanup?.verified !== true || cacheCleanup?.remainingKeys !== 0) {
      throw new AppError(503, 'Redis Knowledge cache cleanup could not be verified', 'KNOWLEDGE_DELETE_CACHE_UNVERIFIED');
    }
    cleanupStage = 'POSTGRES';
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
    return {
      jobId,
      status: 'completed',
      permanentlyDeleted: finished.permanentlyDeleted === true,
      deletedVersionCount: job.versions.length,
      reindexJobId: finished.indexJob?.id ?? null,
      verification: {
        postgresRows: 0,
        ...(job.job_type === 'delete_knowledge_base' ? { agentAssignments: 0 } : {}),
        b2ObjectVersions: storageCleanup.remainingObjectVersions,
        qdrantPoints: qdrantCleanup.remainingCount,
        redisRagKeys: cacheCleanup.remainingKeys,
        bullmqJobs: 0,
      },
    };
  } catch (error) {
    if (error?.code === 'KNOWLEDGE_DELETE_QUEUE_BUSY') {
      await runtime.contextRunner(null, (client) => client.query(
        `UPDATE knowledge_processing_jobs SET status='queued', progress=5,
            attempt_count=GREATEST(attempt_count-1,0), started_at=NULL, completed_at=NULL,
            error_code=$2, error_message=$3 WHERE id=$1`,
        [job.id, error.code, String(error.message).slice(0, 4000)],
      ));
      throw error;
    }
    const stageErrorCode = `KNOWLEDGE_DELETE_${cleanupStage}_FAILED`;
    if (job.attempt_count < job.max_attempts) {
      await queueDeletionRetry(job, error, runtime.contextRunner, stageErrorCode);
    } else {
      await failDeletion(job, error, runtime.contextRunner, stageErrorCode);
    }
    throw error;
  }
}

export function getKnowledgeDeletionJob(auth, jobId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const result = await client.query(
      `SELECT j.id, j.knowledge_base_id, j.document_id, j.job_type, j.status,
              j.progress, j.attempt_count, j.max_attempts, j.error_code,
              j.error_message, j.created_at, j.started_at, j.completed_at
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb
           ON kb.tenant_id=j.tenant_id AND kb.id=j.knowledge_base_id
        WHERE j.tenant_id=$1 AND kb.workspace_id=$2 AND j.id=$3
          AND j.job_type IN ('delete_document','delete_knowledge_base')`,
      [auth.tenantId, auth.workspaceId, jobId],
    );
    if (!result.rowCount) {
      throw new AppError(404, 'Knowledge deletion job was not found', 'KNOWLEDGE_DELETE_JOB_NOT_FOUND');
    }
    const row = result.rows[0];
    return {
      id: row.id,
      knowledgeBaseId: row.knowledge_base_id,
      documentId: row.document_id,
      type: row.job_type,
      status: row.status,
      progress: row.progress,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      failedStage: deletionFailureStage(row.error_code),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  });
}

function deletionFailureStage(errorCode) {
  const code = String(errorCode ?? '').toUpperCase();
  if (code.includes('QUEUE') || code.includes('BULLMQ')) return 'BullMQ jobs';
  if (code.includes('QDRANT')) return 'Qdrant vectors';
  if (code.includes('B2')) return 'Backblaze B2 files';
  if (code.includes('CACHE') || code.includes('REDIS')) return 'Redis caches';
  if (code.includes('POSTGRES') || code.includes('CASCADE')) return 'PostgreSQL records';
  if (code.includes('ACTIVE_CALLS')) return 'active-call drain';
  return errorCode ? 'cleanup verification' : null;
}

export async function retryKnowledgeDeletionJob(
  auth,
  jobId,
  contextRunner = withTenantContext,
  queueAdapter = enqueueKnowledgeProcessingJob,
  queueRemovalAdapter = removeKnowledgeProcessingQueueJobs,
) {
  const job = await contextRunner(auth, async (client) => {
    const result = await client.query(
      `SELECT j.id, j.status, j.job_type, j.knowledge_base_id, j.document_id, j.bullmq_job_id
         FROM knowledge_processing_jobs j
         JOIN knowledge_bases kb ON kb.tenant_id=j.tenant_id AND kb.id=j.knowledge_base_id
        WHERE j.tenant_id=$1 AND kb.workspace_id=$2 AND j.id=$3
          AND j.job_type IN ('delete_document','delete_knowledge_base')
        FOR UPDATE OF j`,
      [auth.tenantId, auth.workspaceId, jobId],
    );
    if (!result.rowCount) {
      throw new AppError(404, 'Knowledge deletion job was not found', 'KNOWLEDGE_DELETE_JOB_NOT_FOUND');
    }
    if (result.rows[0].status !== 'failed') {
      throw new AppError(409, 'Only a failed Knowledge deletion can be retried', 'KNOWLEDGE_DELETE_RETRY_NOT_ALLOWED');
    }
    const updated = await client.query(
      `UPDATE knowledge_processing_jobs SET status='queued', progress=0,
          attempt_count=0, max_attempts=$2, bullmq_job_id=NULL,
          scheduled_at=now(), started_at=NULL, completed_at=NULL,
          error_code=NULL, error_message=NULL
        WHERE id=$1
        RETURNING id, max_attempts`,
      [jobId, permanentKnowledgeDeletionAttempts],
    );
    return {
      id: updated.rows[0].id,
      maxAttempts: updated.rows[0].max_attempts,
      knowledgeBaseId: result.rows[0].knowledge_base_id,
      documentId: result.rows[0].document_id,
      type: result.rows[0].job_type,
      relatedQueueJobIds: [result.rows[0].id, result.rows[0].bullmq_job_id].filter(Boolean).map(String),
    };
  });
  const queueCleanup = await queueRemovalAdapter(job.relatedQueueJobIds);
  if (queueCleanup.active.length || queueCleanup.verified !== true || queueCleanup.remaining?.length) {
    throw new AppError(
      409,
      'The previous BullMQ deletion attempt is still stopping; retry will be reconciled automatically',
      'KNOWLEDGE_DELETE_QUEUE_BUSY',
    );
  }
  await enqueueDeletionJob(auth, job, contextRunner, queueAdapter);
  return {
    id: job.id,
    knowledgeBaseId: job.knowledgeBaseId,
    documentId: job.documentId,
    type: job.type,
    status: 'queued',
    progress: 0,
    attemptCount: 0,
    maxAttempts: job.maxAttempts,
    errorCode: null,
    errorMessage: null,
    failedStage: null,
  };
}

export async function purgePreviouslySoftDeletedKnowledgeBases(
  { execute = false, confirmationToken = null } = {},
  dependencies = defaultProcessingDependencies,
) {
  const runtime = {
    ...defaultProcessingDependencies,
    ...dependencies,
    storage: { ...defaultProcessingDependencies.storage, ...dependencies.storage },
  };
  const candidates = await runtime.contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, workspace_id, name, status, deleted_at,
          (SELECT count(*)::int FROM knowledge_documents d
            WHERE d.tenant_id=kb.tenant_id AND d.knowledge_base_id=kb.id) AS document_count,
          (SELECT count(*)::int FROM knowledge_document_versions v
            WHERE v.tenant_id=kb.tenant_id AND v.knowledge_base_id=kb.id) AS version_count,
          ARRAY(SELECT DISTINCT queue_job_id FROM (
            SELECT j.id::text AS queue_job_id FROM knowledge_processing_jobs j
              WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
            UNION ALL
            SELECT j.bullmq_job_id::text FROM knowledge_processing_jobs j
              WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
                AND j.bullmq_job_id IS NOT NULL
          ) related_queue_jobs) AS bullmq_job_ids
         FROM knowledge_bases kb
        WHERE status='deleted' OR deleted_at IS NOT NULL
        ORDER BY deleted_at NULLS LAST, created_at, id`,
    );
    return result.rows;
  });
  const reviewedSnapshot = candidates.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
  }));
  const expectedConfirmationToken = createHash('sha256')
    .update(JSON.stringify(reviewedSnapshot))
    .digest('hex');
  if (!execute) {
    return {
      execute: false,
      irreversible: true,
      count: candidates.length,
      confirmationToken: expectedConfirmationToken,
      items: candidates.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        name: row.name,
        status: row.status,
        deletedAt: row.deleted_at,
        documentCount: row.document_count,
        versionCount: row.version_count,
        b2Prefix: knowledgeBaseB2Prefix({ tenantId: row.tenant_id, knowledgeBaseId: row.id }),
      })),
    };
  }
  if (!confirmationToken || confirmationToken !== expectedConfirmationToken) {
    throw new AppError(
      409,
      'The irreversible purge requires the confirmation token from the latest dry-run report',
      'KNOWLEDGE_PURGE_DRY_RUN_REQUIRED',
      {
        candidateCount: candidates.length,
        reason: confirmationToken ? 'candidate_list_changed' : 'confirmation_token_missing',
      },
    );
  }

  const results = [];
  for (const row of candidates) {
    const prefix = knowledgeBaseB2Prefix({ tenantId: row.tenant_id, knowledgeBaseId: row.id });
    let stage = 'bullmq';
    try {
      const queueCleanup = await runtime.removeQueueJobs(row.bullmq_job_ids ?? []);
      if (queueCleanup.active.length) throw new Error('Knowledge Base still has active BullMQ jobs');
      if (queueCleanup.verified !== true || queueCleanup.remaining?.length) {
        throw Object.assign(new Error('BullMQ Knowledge Base cleanup could not be verified'), {
          code: 'KNOWLEDGE_DELETE_QUEUE_UNVERIFIED',
        });
      }
      stage = 'qdrant';
      const qdrantCleanup = await runtime.deleteKnowledgeBasePoints(row.tenant_id, row.id);
      if (qdrantCleanup?.verified !== true || qdrantCleanup?.remainingCount !== 0) {
        throw Object.assign(new Error('Qdrant Knowledge Base cleanup could not be verified'), {
          code: 'KNOWLEDGE_DELETE_QDRANT_UNVERIFIED',
        });
      }
      stage = 'b2';
      const storageResult = await runtime.storage.deletePrefix({
        prefix,
        tenantId: row.tenant_id,
        knowledgeBaseId: row.id,
      });
      if (storageResult?.verified !== true || storageResult?.remainingObjectVersions !== 0) {
        throw Object.assign(new Error('B2 Knowledge Base cleanup could not be verified'), {
          code: 'KNOWLEDGE_DELETE_B2_UNVERIFIED',
        });
      }
      stage = 'redis';
      const cacheCleanup = await runtime.invalidateCache(row.tenant_id);
      if (cacheCleanup?.incomplete) throw new Error('Knowledge Base cache cleanup was incomplete');
      if (cacheCleanup?.verified !== true || cacheCleanup?.remainingKeys !== 0) {
        throw Object.assign(new Error('Redis Knowledge Base cache cleanup could not be verified'), {
          code: 'KNOWLEDGE_DELETE_CACHE_UNVERIFIED',
        });
      }
      stage = 'postgres';
      const postgresCleanup = await runtime.contextRunner(null, (client) => hardDeleteKnowledgeBaseInTransaction(client, {
        tenantId: row.tenant_id,
        knowledgeBaseId: row.id,
        requireSoftDeleted: true,
      }));
      results.push({
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        status: postgresCleanup.deleted ? 'purged' : 'already_purged',
        deleted: postgresCleanup.deleted,
        success: true,
        removedBullmqJobs: queueCleanup.removed.length,
        deletedB2ObjectVersions: storageResult.deletedCount,
        qdrantCleaned: qdrantCleanup?.verified !== false,
        remainingQdrantPoints: qdrantCleanup?.remainingCount ?? 0,
        redisKeysDeleted: cacheCleanup?.deletedKeys ?? 0,
        postgresCleaned: true,
      });
    } catch (error) {
      results.push({
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        status: 'failed',
        deleted: false,
        success: false,
        failedStage: stage,
        errorCode: error?.code ?? 'KNOWLEDGE_PURGE_FAILED',
        error: String(error.message ?? error).slice(0, 1000),
      });
    }
  }
  return {
    execute: true,
    confirmationToken,
    count: candidates.length,
    deletedCount: results.filter((result) => result.status === 'purged').length,
    alreadyPurgedCount: results.filter((result) => result.status === 'already_purged').length,
    failedCount: results.filter((result) => result.status === 'failed').length,
    items: results,
  };
}
