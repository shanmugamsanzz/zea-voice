import { withTenantContext } from '../infrastructure/database-context.js';
import { requireTenantId } from '../rag/tenant-isolation.js';
import { enqueueKnowledgeProcessingJob } from './knowledge-processing.queue.js';
//test deployment 
function identityKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

export async function schedulePublishedArtifactRecovery(
  auth,
  publications = [],
  recoveryReason = 'authoritative_hydration_incomplete',
  dependencies = {},
) {
  const tenantId = requireTenantId(auth?.tenantId);
  const contextRunner = dependencies.contextRunner ?? withTenantContext;
  const enqueue = dependencies.enqueueProcessingJob ?? enqueueKnowledgeProcessingJob;
  const identities = [...new Map(publications.map((publication) => {
    const identity = Object.freeze({
      tenantId,
      knowledgeBaseId: String(publication?.knowledgeBaseId ?? '').trim(),
      publicationRevision: Number(publication?.publicationRevision),
    });
    return [`${identityKey(identity.knowledgeBaseId)}:${identity.publicationRevision}`, identity];
  }).filter(([, identity]) => (
    identity.knowledgeBaseId && Number.isInteger(identity.publicationRevision)
      && identity.publicationRevision > 0
  ))).values()];

  const recoveries = await Promise.all(identities.map(async (identity) => {
    const recovery = await contextRunner(auth, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `knowledge-artifact-recovery:${identity.tenantId}:${identity.knowledgeBaseId}:${identity.publicationRevision}`,
      ]);
      const existing = await client.query(
        `SELECT id, max_attempts, bullmq_job_id
           FROM knowledge_processing_jobs
          WHERE tenant_id=$1 AND knowledge_base_id=$2 AND job_type='index'
            AND status IN ('queued','running')
            AND metadata->>'artifactRecovery'='true'
            AND metadata->>'publicationRevision'=$3
          ORDER BY created_at DESC LIMIT 1`,
        [identity.tenantId, identity.knowledgeBaseId, String(identity.publicationRevision)],
      );
      if (existing.rowCount) return { ...existing.rows[0], created: false };
      const inserted = await client.query(
        `INSERT INTO knowledge_processing_jobs (
           tenant_id, knowledge_base_id, job_type, status, queue_name, metadata
         )
         SELECT $1,$2,'index','queued','knowledge-processing',$3::jsonb
          WHERE EXISTS (
            SELECT 1 FROM knowledge_bases
             WHERE tenant_id=$1 AND id=$2 AND status='published'
               AND deleted_at IS NULL AND publication_revision=$4
          )
         RETURNING id, max_attempts, bullmq_job_id`,
        [identity.tenantId, identity.knowledgeBaseId, JSON.stringify({
          publicationRevision: identity.publicationRevision,
          artifactRecovery: true,
          recoveryReason,
        }), identity.publicationRevision],
      );
      return inserted.rowCount ? { ...inserted.rows[0], created: true } : null;
    });
    if (!recovery) return Object.freeze({
      ...identity, scheduled: false, reason: 'publication_not_active',
    });
    if (recovery.bullmq_job_id) return Object.freeze({
      ...identity, scheduled: true, queued: true,
      jobId: String(recovery.id), deduplicated: true,
    });
    try {
      const queued = await enqueue({
        processingJobId: recovery.id,
        maxAttempts: recovery.max_attempts,
      });
      await contextRunner(auth, (client) => client.query(
        `UPDATE knowledge_processing_jobs SET bullmq_job_id=$3,
            error_code=NULL, error_message=NULL
          WHERE tenant_id=$1 AND id=$2 AND status='queued'`,
        [identity.tenantId, recovery.id, queued.id],
      ));
      return Object.freeze({
        ...identity, scheduled: true, queued: true,
        jobId: String(recovery.id), deduplicated: !recovery.created,
      });
    } catch (error) {
      await contextRunner(auth, (client) => client.query(
        `UPDATE knowledge_processing_jobs
            SET error_code='QUEUE_UNAVAILABLE', error_message=$3
          WHERE tenant_id=$1 AND id=$2 AND status='queued'`,
        [identity.tenantId, recovery.id, String(error.message ?? error).slice(0, 4000)],
      )).catch(() => {});
      return Object.freeze({
        ...identity, scheduled: true, queued: false, jobId: String(recovery.id),
      });
    }
  }));
  return Object.freeze(recoveries);
}
