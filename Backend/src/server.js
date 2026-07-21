import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { checkDatabase, closeDatabase } from './infrastructure/database.js';
import { runPendingMigrations } from './infrastructure/migrations.js';
import { checkRedis, closeRedis } from './infrastructure/redis.js';
import { closeQueues } from './queues/queue.registry.js';
import { closeCampaignWorkers, startCampaignWorkers } from './campaigns/campaign.workers.js';
import { assertRagInfrastructure } from './rag/rag-infrastructure.js';
import { closeKnowledgeProcessingWorker, startKnowledgeProcessingWorker } from './knowledge-bases/knowledge-processing.worker.js';

async function bootstrap() {
  await runPendingMigrations();
  const [databaseHealth, redisHealth, ragHealth] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    env.RAG_ENABLED && env.RAG_STARTUP_CHECK_ENABLED
      ? assertRagInfrastructure()
      : Promise.resolve({ ok: true, enabled: env.RAG_ENABLED, skipped: true }),
  ]);

  logger.info({ databaseHealth, redisHealth, ragHealth }, 'Infrastructure connections verified');
  startCampaignWorkers();
  await startKnowledgeProcessingWorker();

  const server = createServer(createApp());
  server.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT }, 'Zea Voice API is running');
    logger.warn({
      icon: '⚠️', stage: 'voice.media_runtime', status: 'not_implemented',
      mediaPath: '/webhooks/plivo/media',
    }, '⚠️ Voice calls can be answered, but Plivo audio streaming, STT, LLM and TTS execution are not implemented');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');

    server.close(async (serverError) => {
      const results = await Promise.allSettled([
        closeCampaignWorkers(), closeKnowledgeProcessingWorker(), closeQueues(), closeRedis(), closeDatabase(),
      ]);
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
  await Promise.allSettled([
    closeCampaignWorkers(), closeKnowledgeProcessingWorker(), closeQueues(), closeRedis(), closeDatabase(),
  ]);
  process.exit(1);
});
