import os from 'node:os';
import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';

const definitions = [
  { name: 'batch-calls', displayName: 'Batch Campaign Calls' },
  { name: 'realtime-calls', displayName: 'Real-Time Lead Calls' },
  { name: 'call-retries', displayName: 'Scheduled Call Retries' },
];
const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  maxRetriesPerRequest: null,
};
const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
const queueInstances = new Map();

export function getQueue(queueName) {
  if (!definitionsByName.has(queueName)) return null;
  if (!queueInstances.has(queueName)) {
    queueInstances.set(queueName, new Queue(queueName, { connection, prefix: env.QUEUE_PREFIX }));
  }
  return queueInstances.get(queueName);
}

export function assertQueue(queueName) {
  const queue = getQueue(queueName);
  if (!queue) return null;
  return queue;
}

function statusFor(waiting, maxWaitTime, paused) {
  if (paused) return 'paused';
  if (waiting >= env.QUEUE_CRITICAL_WAITING || maxWaitTime >= env.QUEUE_CRITICAL_WAIT_SECONDS) return 'critical';
  if (waiting >= env.QUEUE_CONGESTED_WAITING || maxWaitTime >= env.QUEUE_CONGESTED_WAIT_SECONDS) return 'congested';
  return 'normal';
}

async function metrics(entry) {
  const [counts, paused, jobs] = await Promise.all([
    entry.queue.getJobCounts('wait', 'active', 'delayed', 'prioritized', 'completed', 'failed'),
    entry.queue.isPaused(),
    entry.queue.getJobs(['wait', 'delayed', 'prioritized'], 0, 499, true),
  ]);
  const now = Date.now();
  const waits = jobs.map((job) => Math.max(0, Math.floor((now - job.timestamp) / 1000)));
  const waitingCalls = (counts.wait ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
  const maxWaitTime = waits.length ? Math.max(...waits) : 0;
  return {
    id: entry.name,
    name: entry.displayName,
    queueName: entry.name,
    status: statusFor(waitingCalls, maxWaitTime, paused),
    paused,
    activeCalls: counts.active ?? 0,
    waitingCalls,
    avgWaitTime: waits.length ? Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length) : 0,
    maxWaitTime,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  };
}

export async function listQueueMetrics() {
  return Promise.all(definitions.map((definition) => metrics({ ...definition, queue: getQueue(definition.name) })));
}

export async function pauseQueue(queueName) {
  const queue = assertQueue(queueName);
  if (!queue) return false;
  await queue.pause();
  return true;
}

export async function resumeQueue(queueName) {
  const queue = assertQueue(queueName);
  if (!queue) return false;
  await queue.resume();
  return true;
}

export async function flushQueue(queueName) {
  const queue = assertQueue(queueName);
  if (!queue) return null;
  const before = await queue.getJobCounts('wait', 'delayed', 'prioritized');
  await queue.drain(true);
  return (before.wait ?? 0) + (before.delayed ?? 0) + (before.prioritized ?? 0);
}

const heartbeatKey = (workerId) => `${env.QUEUE_PREFIX}:worker-heartbeat:${workerId}`;

export async function recordWorkerHeartbeat({ workerId, queueName, concurrency, status = 'running' }) {
  if (!definitionsByName.has(queueName)) throw new Error(`Unknown queue: ${queueName}`);
  const value = JSON.stringify({
    workerId, queueName, concurrency, status, hostname: os.hostname(), pid: process.pid,
    lastHeartbeatAt: new Date().toISOString(),
  });
  await redis.set(heartbeatKey(workerId), value, 'EX', env.WORKER_HEARTBEAT_TTL_SECONDS);
  return JSON.parse(value);
}

export async function listWorkerHeartbeats() {
  let cursor = '0';
  const keys = [];
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${env.QUEUE_PREFIX}:worker-heartbeat:*`, 'COUNT', 100);
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');
  if (!keys.length) return [];
  const values = await redis.mget(keys);
  return values.filter(Boolean).map((value) => JSON.parse(value));
}

export async function getWorkerHealth() {
  const workers = await listWorkerHeartbeats();
  return { ok: true, status: workers.length ? 'running' : 'idle', configured: true, count: workers.length, workers };
}

export async function closeQueues() {
  await Promise.all([...queueInstances.values()].map((queue) => queue.close()));
  queueInstances.clear();
}
