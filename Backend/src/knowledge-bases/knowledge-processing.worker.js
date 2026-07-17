import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { executeKnowledgeJob } from './knowledge-job.dispatcher.js';
import { requeuePendingKnowledgeJobs } from './knowledge-processing.queue.js';

const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,
};

let worker;

export async function startKnowledgeProcessingWorker() {
  if (!env.RAG_ENABLED || !env.KNOWLEDGE_WORKERS_ENABLED || worker) return worker;
  const requeued = await requeuePendingKnowledgeJobs();
  worker = new Worker(
    'knowledge-processing',
    (job) => executeKnowledgeJob(job.data.processingJobId),
    {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.KNOWLEDGE_WORKER_CONCURRENCY,
    },
  );
  worker.on('failed', (job, error) => {
    logger.error({ err: error, queueName: 'knowledge-processing', jobId: job?.id }, 'Knowledge job failed');
  });
  worker.on('error', (error) => {
    logger.error({ err: error, queueName: 'knowledge-processing' }, 'Knowledge worker error');
  });
  logger.info({ requeued, concurrency: env.KNOWLEDGE_WORKER_CONCURRENCY }, 'Knowledge processing worker started');
  return worker;
}

export async function closeKnowledgeProcessingWorker() {
  if (!worker) return;
  const closing = worker;
  worker = undefined;
  await closing.close();
}
