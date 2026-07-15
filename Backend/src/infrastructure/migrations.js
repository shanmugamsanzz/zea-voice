import path from 'node:path';
import { runner } from 'node-pg-migrate';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export async function runPendingMigrations() {
  if (!env.AUTO_MIGRATE) {
    logger.info('Automatic database migrations are disabled');
    return;
  }

  const migrationsDirectory = path.resolve(process.cwd(), 'migrations');
  logger.info({ migrationsDirectory }, 'Applying pending database migrations');

  await runner({
    databaseUrl: env.DATABASE_URL,
    dir: migrationsDirectory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: (message) => logger.info({ migration: message }),
  });

  logger.info('Database migrations are up to date');
}
