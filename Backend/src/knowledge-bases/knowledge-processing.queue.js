import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { getQueue } from '../queues/queue.registry.js';

export async function enqueueKnowledgeProcessingJob({
  processingJobId,
  maxAttempts = 3,
  removeOnComplete = 1000,
}) {
  const queue = getQueue('knowledge-processing');
  const permanentDeletion = removeOnComplete === true;
  const job = await queue.add(
    'extract-pdf-text',
    { processingJobId },
    {
      jobId: processingJobId,
      attempts: permanentDeletion ? Math.max(maxAttempts, 17_280) : maxAttempts,
      backoff: permanentDeletion
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
  queue = getQueue('knowledge-processing'),
) {
  if (!queue) throw new Error('Knowledge processing queue is not available');
  const targetIds = [...new Set(jobIds.filter(Boolean).map(String))];
  const removed = [];
  const active = [];
  const missing = [];
  for (const jobId of targetIds) {
    const job = await queue.getJob(jobId);
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
      const current = await queue.getJob(jobId);
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
    const job = await queue.getJob(jobId);
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

export async function requeuePendingKnowledgeJobs() {
  const jobs = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT id, max_attempts, job_type
         FROM knowledge_processing_jobs
        WHERE status = 'queued' AND bullmq_job_id IS NULL
          AND attempt_count < max_attempts
        ORDER BY scheduled_at, created_at
        LIMIT 1000`,
    );
    return result.rows;
  });
  for (const job of jobs) {
    const queued = await enqueueKnowledgeProcessingJob({
      processingJobId: job.id,
      maxAttempts: job.max_attempts,
      removeOnComplete: job.job_type === 'delete_knowledge_base' ? true : 1000,
    });
    await withPlatformAdminContext(null, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id = $2, error_code = NULL, error_message = NULL
        WHERE id = $1 AND status = 'queued'`,
      [job.id, queued.id],
    ));
  }
  return jobs.length;
}
