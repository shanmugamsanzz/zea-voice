import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import { flushQueueSchema, parseQueueInput, queueNameSchema } from './queue.schemas.js';
import { emergencyFlush, getQueueMonitor, getWorkerMonitor, setQueuePaused } from './queue.service.js';

function valid(schema, value) {
  const parsed = parseQueueInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const queueAdminRouter = Router();
queueAdminRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
queueAdminRouter.get('/', async (_req, res) => res.json({ success: true, data: await getQueueMonitor() }));
queueAdminRouter.get('/workers', async (_req, res) => res.json({ success: true, data: await getWorkerMonitor() }));
queueAdminRouter.post('/:queueName/pause', async (req, res) => {
  const { queueName } = valid(queueNameSchema, req.params);
  res.json({ success: true, data: await setQueuePaused(req.auth.userId, queueName, true) });
});
queueAdminRouter.post('/:queueName/resume', async (req, res) => {
  const { queueName } = valid(queueNameSchema, req.params);
  res.json({ success: true, data: await setQueuePaused(req.auth.userId, queueName, false) });
});
queueAdminRouter.post('/:queueName/flush', async (req, res) => {
  const { queueName } = valid(queueNameSchema, req.params);
  const { reason } = valid(flushQueueSchema, req.body);
  res.json({ success: true, data: await emergencyFlush(req.auth.userId, queueName, reason) });
});
