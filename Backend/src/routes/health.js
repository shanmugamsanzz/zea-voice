import { Router } from 'express';
import { checkDatabase } from '../infrastructure/database.js';
import { checkRedis } from '../infrastructure/redis.js';
import { getWorkerHealth } from '../queues/queue.registry.js';

export const healthRouter = Router();

healthRouter.get('/', async (_request, response) => {
  const [database, redis, workers] = await Promise.allSettled([checkDatabase(), checkRedis(), getWorkerHealth()]);
  const healthy = database.status === 'fulfilled' && redis.status === 'fulfilled' && workers.status === 'fulfilled';

  response.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: database.status === 'fulfilled' ? database.value : { ok: false },
      redis: redis.status === 'fulfilled' ? redis.value : { ok: false },
      workers: workers.status === 'fulfilled' ? workers.value : { ok: false },
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
