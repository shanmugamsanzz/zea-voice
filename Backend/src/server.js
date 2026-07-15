import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { checkDatabase, closeDatabase } from './infrastructure/database.js';
import { runPendingMigrations } from './infrastructure/migrations.js';
import { checkRedis, closeRedis } from './infrastructure/redis.js';
import { closeQueues } from './queues/queue.registry.js';
import { closeCampaignWorkers, startCampaignWorkers } from './campaigns/campaign.workers.js';

async function bootstrap() {
  await runPendingMigrations();
  const [databaseHealth, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

  logger.info({ databaseHealth, redisHealth }, 'Infrastructure connections verified');
  startCampaignWorkers();

  const server = createServer(createApp());
  server.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT }, 'Zea Voice API is running');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');

    server.close(async (serverError) => {
      const results = await Promise.allSettled([closeCampaignWorkers(), closeQueues(), closeRedis(), closeDatabase()]);
      const failed = results.filter((result) => result.status === 'rejected');

      if (serverError || failed.length > 0) {
        logger.error({ serverError, failed }, 'Shutdown completed with errors');
        process.exitCode = 1;
      } else {
        logger.info('Graceful shutdown completed');
      }
    });

    setTimeout(() => {
      logger.fatal('Graceful shutdown timed out');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch(async (error) => {
  logger.fatal({ err: error }, 'Backend startup failed');
  await Promise.allSettled([closeCampaignWorkers(), closeQueues(), closeRedis(), closeDatabase()]);
  process.exit(1);
});
