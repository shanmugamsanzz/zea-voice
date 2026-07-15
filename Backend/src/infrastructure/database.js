import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const { Pool } = pg;
const runtimeRole = 'zea_voice_runtime';

export const database = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: env.DATABASE_IDLE_TIMEOUT_MS,
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  options: `-c role=${runtimeRole}`,
  application_name: 'zea-voice-api',
});

database.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected PostgreSQL pool error');
});

export async function checkDatabase() {
  const startedAt = performance.now();
  const result = await database.query('SELECT current_user AS current_role');
  if (result.rows[0]?.current_role !== runtimeRole) {
    throw new Error(`Database safety check failed: expected restricted role ${runtimeRole}`);
  }
  return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
}

export async function closeDatabase() {
  await database.end();
}
