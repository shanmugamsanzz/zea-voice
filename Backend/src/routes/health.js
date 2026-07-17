import { Router } from 'express';
import { checkDatabase } from '../infrastructure/database.js';
import { checkRedis } from '../infrastructure/redis.js';
import { getWorkerHealth } from '../queues/queue.registry.js';
import { checkB2 } from '../rag/b2.client.js';
import { checkEmbedding } from '../rag/embedding.client.js';
import { checkQdrant } from '../rag/qdrant.client.js';
import { checkRagInfrastructure } from '../rag/rag-infrastructure.js';

export const healthRouter = Router();

healthRouter.get('/', async (_request, response) => {
  const [database, redis, workers, rag] = await Promise.allSettled([
    checkDatabase(), checkRedis(), getWorkerHealth(), checkRagInfrastructure(),
  ]);
  const healthy = database.status === 'fulfilled'
    && redis.status === 'fulfilled'
    && workers.status === 'fulfilled'
    && rag.status === 'fulfilled'
    && rag.value.ok;

  response.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: database.status === 'fulfilled' ? database.value : { ok: false },
      redis: redis.status === 'fulfilled' ? redis.value : { ok: false },
      workers: workers.status === 'fulfilled' ? workers.value : { ok: false },
      rag: rag.status === 'fulfilled' ? rag.value : { ok: false },
    },
  });
});

healthRouter.get('/database', async (_request, response, next) => {
  try {
    response.json({ success: true, service: 'database', ...(await checkDatabase()) });
  } catch (error) {
    next(error);
  }
});

healthRouter.get('/redis', async (_request, response, next) => {
  try {
    response.json({ success: true, service: 'redis', ...(await checkRedis()) });
  } catch (error) {
    next(error);
  }
});

healthRouter.get('/workers', async (_request, response, next) => {
  try {
    response.json({ success: true, service: 'workers', ...(await getWorkerHealth()) });
  } catch (error) {
    next(error);
  }
});

healthRouter.get('/rag', async (_request, response, next) => {
  try {
    const health = await checkRagInfrastructure({ force: true });
    response.status(health.ok ? 200 : 503).json({ success: health.ok, service: 'rag', ...health });
  } catch (error) {
    next(error);
  }
});

healthRouter.get('/embedding', async (_request, response, next) => {
  try {
    response.json({ success: true, service: 'embedding', ...(await checkEmbedding()) });
  } catch (error) {
    next(error);
  }
});

healthRouter.get('/qdrant', async (_request, response, next) => {
  try {
    response.json({ success: true, service: 'qdrant', ...(await checkQdrant()) });
  } catch (error) {
    next(error);
  }
});

healthRouter.get('/b2', async (_request, response, next) => {
  try {
    response.json({ success: true, service: 'b2', ...(await checkB2()) });
  } catch (error) {
    next(error);
  }
});
