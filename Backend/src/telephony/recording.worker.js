import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { processPlivoRecording } from './plivo-recording.service.js';

const connection = {
  host: env.REDIS_HOST, port: env.REDIS_PORT, password: env.REDIS_PASSWORD,
  db: env.REDIS_DB, maxRetriesPerRequest: null,
};
let worker;

export function startRecordingWorker() {
  if (worker) return worker;
  worker = new Worker('recording-processing', (job) => processPlivoRecording(job.data.callId), {
    connection, prefix: env.QUEUE_PREFIX, concurrency: 2,
  });
  worker.on('failed', (job, error) => logger.error({ err: error, stage: 'recording.failed',
    callId: job?.data?.callId, jobId: job?.id, attemptsMade: job?.attemptsMade }, 'Call recording storage failed'));
  worker.on('error', (error) => logger.error({ err: error, stage: 'recording.worker_error' },
    'Call recording worker error'));
  logger.info({ stage: 'recording.worker_ready', concurrency: 2 }, 'Call recording worker started');
  return worker;
}

export async function closeRecordingWorker() {
  if (!worker) return;
  const current = worker; worker = undefined;
  await current.close();
}
