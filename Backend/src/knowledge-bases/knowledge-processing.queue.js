import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { getQueue } from '../queues/queue.registry.js';

export async function enqueueKnowledgeProcessingJob({ processingJobId, maxAttempts = 3 }) {
  const queue = getQueue('knowledge-processing');
  const job = await queue.add(
    'extract-pdf-text',
    { processingJobId },
    {
      jobId: processingJobId,
      attempts: maxAttempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
  return { id: job.id };
}

export async function requeuePendingKnowledgeJobs() {
  const jobs = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT id, max_attempts
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
    });
    await withPlatformAdminContext(null, (client) => client.query(
      `UPDATE knowledge_processing_jobs SET bullmq_job_id = $2, error_code = NULL, error_message = NULL
        WHERE id = $1 AND status = 'queued'`,
      [job.id, queued.id],
    ));
  }
  return jobs.length;
}
