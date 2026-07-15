import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  db: env.REDIS_DB,
  lazyConnect: true,
  connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  keepAlive: 10_000,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (attempt) => Math.min(attempt * 200, env.REDIS_MAX_RETRY_DELAY_MS),
});

redis.on('error', (error) => {
  logger.error({ err: error }, 'Redis connection error');
});

export async function connectRedis() {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}

export async function checkRedis() {
  await connectRedis();
  const startedAt = performance.now();
  const response = await redis.ping();
  if (response !== 'PONG') {
    throw new Error(`Unexpected Redis ping response: ${response}`);
  }
  return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
}

export async function closeRedis() {
  if (redis.status !== 'end') {
    await redis.quit();
  }
}
