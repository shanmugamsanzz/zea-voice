import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errors.js';
import { processPlivoCallback } from './plivo-webhook.service.js';

const paramsSchema = z.object({ attemptId: z.string().uuid(), eventType: z.enum(['ring', 'hangup']) });
export const plivoWebhookRouter = Router();

plivoWebhookRouter.post('/calls/:attemptId/:eventType', async (req, res) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) throw new AppError(400, 'Invalid callback path', 'VALIDATION_ERROR');
  const data = await processPlivoCallback({
    ...parsed.data,
    payload: req.body ?? {},
    signature: req.get('x-plivo-signature-v3'),
    nonce: req.get('x-plivo-signature-v3-nonce'),
  });
  res.json({ success: true, data });
});
