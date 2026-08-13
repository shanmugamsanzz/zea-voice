import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { getQueue } from '../queues/queue.registry.js';

// Five-second retries for 24 hours. Permanent deletion must survive temporary
// Redis, Qdrant, B2 and database outages instead of stopping after three tries.
export const permanentKnowledgeDeletionAttempts = 17_280;

export async function enqueueKnowledgeProcessingJob({
  processingJobId,
  maxAttempts = 3,
  removeOnComplete = 1000,
  permanentDeletion = false,
}, queue = getQueue('knowledge-processing')) {
  const durableDeletion = permanentDeletion || removeOnComplete === true;
  const job = await queue.add(
    'extract-pdf-text',
    { processingJobId },
    {
      jobId: processingJobId,
      attempts: durableDeletion ? Math.max(maxAttempts, permanentKnowledgeDeletionAttempts) : maxAttempts,
      backoff: durableDeletion
        ? { type: 'fixed', delay: 5000 }
        : { type: 'exponential', delay: 5000 },
      removeOnComplete,
      removeOnFail: 5000,
    },
  );
  return { id: job.id };
}

export async function removeKnowledgeProcessingQueueJobs(
  jobIds = [],
  queue = undefined,
) {
  const targetIds = [...new Set(jobIds.filter(Boolean).map(String))];
  if (!targetIds.length) {
    return { removed: [], active: [], missing: [], verified: true, remaining: [] };
  }
  const runtimeQueue = queue ?? getQueue('knowledge-processing');
  if (!runtimeQueue) throw new Error('Knowledge processing queue is not available');
  const removed = [];
  const active = [];
  const missing = [];
  for (const jobId of targetIds) {
    const job = await runtimeQueue.getJob(jobId);
    if (!job) {
      missing.push(jobId);
      continue;
    }
    const state = await job.getState();
    if (state === 'active') {
      active.push(jobId);
      continue;
    }
    try {
      await job.remove();
    } catch (error) {
      const current = await runtimeQueue.getJob(jobId);
      if (!current) {
        removed.push(jobId);
        continue;
      }
      if (current && await current.getState() === 'active') {
        active.push(jobId);
        continue;
      }
      throw error;
    }
    removed.push(jobId);
  }
  const remaining = [];
  for (const jobId of removed) {
    const job = await runtimeQueue.getJob(jobId);
    if (job) remaining.push(jobId);
  }
  if (remaining.length) {
    const error = new Error(`BullMQ retained ${remaining.length} Knowledge Base job(s) after removal`);
    error.code = 'KNOWLEDGE_QUEUE_DELETE_INCOMPLETE';
    error.remainingJobIds = remaining;
    throw error;
  }
  return {
    removed,
    active: [...new Set(active)],
    missing,
    verified: active.length === 0,
    remaining: [],
  };
}

export async function requeuePendingKnowledgeJobs(
  queue = getQueue('knowledge-processing'),
  contextRunner = withPlatformAdminContext,
) {
  // Repair unfinished jobs created by releases that allowed only three or ten
  // attempts. This makes deployment self-heal deletions that were already
  // queued or failed before durable retry support was introduced.
  await contextRunner(null, (client) => client.query(
    `UPDATE knowledge_processing_jobs
        SET max_attempts=GREATEST(max_attempts,$1)
      WHERE job_type IN ('delete_document','delete_knowledge_base')
        AND status IN ('queued','running','failed')`,
    [permanentKnowledgeDeletionAttempts],
  ));
  const jobs = await contextRunner(null, async (client) => {
    const result = await client.query(
      `SELECT id, max_attempts, job_type
         FROM knowledge_processing_jobs
        WHERE attempt_count < max_attempts
          AND (
            (status='queued' AND bullmq_job_id IS NULL)
            OR (job_type IN ('delete_document','delete_knowledge_base')
              AND status IN ('queued','running','failed'))
          )
        ORDER BY scheduled_at, created_at
        LIMIT 1000`,
    );
    return result.rows;
  });
  let reconciled = 0;
  for (const job of jobs) {
    const existing = await queue.getJob(String(job.id));
    if (existing) {
      const state = await existing.getState();
      // Waiting, delayed and active jobs are already owned by BullMQ. A
      // completed or exhausted failed queue job with a non-completed database
      // row is stale and is replaced below with the durable retry policy.
      if (!['completed', 'failed'].includes(state)) continue;
      await existing.remove();
    }
    const queued = await enqueueKnowledgeProcessingJob({
      processingJobId: job.id,
      maxAttempts: job.max_attempts,
      removeOnComplete: job.job_type.startsWith('delete_') ? true : 1000,
      permanentDeletion: job.job_type.startsWith('delete_'),
    }, queue);
    await contextRunner(null, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id=$2, status='queued',
          completed_at=NULL WHERE id=$1 AND status <> 'completed'`,
      [job.id, queued.id],
    ));
    reconciled += 1;
  }
  return reconciled;
}
