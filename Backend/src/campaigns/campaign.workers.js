import { Worker, DelayedError } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { executeCampaignTask } from './campaign-execution.service.js';

const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,
};
const workers = [];

export async function processCampaignQueueJob(job, token, dependencies = {}) {
  const execute = dependencies.executeTask ?? executeCampaignTask;
  return execute(job.data.taskId, {
    deferTask: async (_task, delay) => {
      // Keep the same job in its original batch/realtime/retry queue. Waiting
      // for capacity is not a failed call attempt and consumes no retries.
      await job.moveToDelayed((dependencies.now?.() ?? Date.now()) + delay, token);
      throw new DelayedError();
    },
  });
}

export function startCampaignWorkers() {
  if (!env.CAMPAIGN_WORKERS_ENABLED || workers.length) return workers;
  for (const queueName of ['batch-calls', 'realtime-calls', 'call-retries']) {
    const worker = new Worker(queueName, (job, token) => processCampaignQueueJob(job, token), {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.CAMPAIGN_WORKER_CONCURRENCY,
    });
    worker.on('failed', (job, error) => logger.error({ err: error, queueName, jobId: job?.id }, 'Campaign job failed'));
    worker.on('error', (error) => logger.error({ err: error, queueName }, 'Campaign worker error'));
    workers.push(worker);
  }
  logger.info({ queues: workers.length }, 'Campaign workers started');
  return workers;
}

export async function closeCampaignWorkers() {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
}
