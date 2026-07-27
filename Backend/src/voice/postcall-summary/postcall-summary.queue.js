import { getQueue } from '../../queues/queue.registry.js';
import { env } from '../../config/env.js';
import {
  attachPostCallSummaryQueueJob,
  createQueuedPostCallSummaryJob,
  listRecoverablePostCallSummaryJobs,
  recordPostCallSummaryQueueFailure,
} from './postcall-summary-job.service.js';

export async function enqueuePostCallSummaryJob({ summaryJobId, maxAttempts = 3 }, dependencies = {}) {
  const queue = dependencies.queue ?? getQueue('post-call-summarization');
  if (!queue) throw new Error('Post-Call summarization queue is unavailable');
  const job = await queue.add('summarize-call', { summaryJobId }, {
    jobId: summaryJobId,
    attempts: maxAttempts,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
  return { id: String(job.id) };
}

export async function queuePostCallSummary(callSessionId, dependencies = {}) {
  const createJob = dependencies.createJob ?? createQueuedPostCallSummaryJob;
  const jobDependencies = {
    ...dependencies,
    maxAttempts: dependencies.maxAttempts ?? env.POSTCALL_SUMMARY_MAX_ATTEMPTS,
  };
  const summaryJob = await createJob(callSessionId, jobDependencies);
  if (!summaryJob) return { queued: false, reason: 'not_configured', job: null };
  if (summaryJob.status !== 'queued') return { queued: false, reason: 'already_finalized', job: summaryJob };
  if (summaryJob.bullmqJobId) return { queued: true, reason: 'already_queued', job: summaryJob };
  try {
    const queued = await enqueuePostCallSummaryJob({
      summaryJobId: summaryJob.id,
      maxAttempts: summaryJob.maxAttempts,
    }, jobDependencies);
    const attach = dependencies.attachJob ?? attachPostCallSummaryQueueJob;
    const attached = await attach(summaryJob.id, queued.id, jobDependencies);
    return { queued: true, reason: summaryJob.newlyCreated ? 'created' : 'recovered', job: attached };
  } catch (error) {
    const recordFailure = dependencies.recordQueueFailure ?? recordPostCallSummaryQueueFailure;
    await recordFailure(summaryJob.id, error, jobDependencies);
    throw error;
  }
}

export async function requeuePendingPostCallSummaryJobs(dependencies = {}) {
  const listJobs = dependencies.listJobs ?? listRecoverablePostCallSummaryJobs;
  const jobs = await listJobs(dependencies);
  let requeued = 0;
  for (const job of jobs) {
    try {
      const queued = await enqueuePostCallSummaryJob({
        summaryJobId: job.id, maxAttempts: job.maxAttempts,
      }, dependencies);
      const attach = dependencies.attachJob ?? attachPostCallSummaryQueueJob;
      await attach(job.id, queued.id, dependencies);
      requeued += 1;
    } catch (error) {
      const recordFailure = dependencies.recordQueueFailure ?? recordPostCallSummaryQueueFailure;
      await recordFailure(job.id, error, dependencies);
    }
  }
  return requeued;
}
