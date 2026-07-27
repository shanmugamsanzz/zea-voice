import { Worker } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { requeuePendingPostCallSummaryJobs } from './postcall-summary.queue.js';

const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,
};

let worker;

export async function startPostCallSummaryWorker(processor, dependencies = {}) {
  if (!env.POSTCALL_SUMMARY_WORKERS_ENABLED || worker) return worker;
  if (typeof processor !== 'function') {
    throw new TypeError('A Post-Call summary processor is required before the worker can start');
  }
  const requeue = dependencies.requeue ?? requeuePendingPostCallSummaryJobs;
  const requeued = await requeue(dependencies);
  const WorkerClass = dependencies.WorkerClass ?? Worker;
  worker = new WorkerClass(
    'post-call-summarization',
    (job) => processor(job.data.summaryJobId, {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? env.POSTCALL_SUMMARY_MAX_ATTEMPTS,
    }),
    {
      connection: dependencies.connection ?? connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.POSTCALL_SUMMARY_WORKER_CONCURRENCY,
    },
  );
  worker.on('failed', (job, error) => logger.error({
    err: error, stage: 'postcall_summary.failed', summaryJobId: job?.data?.summaryJobId,
    jobId: job?.id, attemptsMade: job?.attemptsMade,
  }, 'Post-Call AI summarization failed'));
  worker.on('error', (error) => logger.error({ err: error, stage: 'postcall_summary.worker_error' },
    'Post-Call summarization worker error'));
  logger.info({
    stage: 'postcall_summary.worker_ready', requeued,
    concurrency: env.POSTCALL_SUMMARY_WORKER_CONCURRENCY,
  }, 'Post-Call summarization worker started');
  return worker;
}

export async function closePostCallSummaryWorker() {
  if (!worker) return;
  const closing = worker;
  worker = undefined;
  await closing.close();
}

