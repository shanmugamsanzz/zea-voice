import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errors.js';
import { processInboundPlivoHangup, processPlivoCallback } from './plivo-webhook.service.js';
import { acceptPlivoRecordingCallback } from './plivo-recording.service.js';

const paramsSchema = z.object({ attemptId: z.string().uuid(), eventType: z.enum(['ring', 'hangup']) });
const storedHangupQuerySchema = z.object({ attempt_id: z.string().uuid() });
const recordingQuerySchema = z.object({ call_id: z.string().uuid() });
export const plivoWebhookRouter = Router();

plivoWebhookRouter.post('/recording', async (req, res) => {
  const parsed = recordingQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, 'Invalid recording callback', 'VALIDATION_ERROR');
  const data = await acceptPlivoRecordingCallback({
    callId: parsed.data.call_id,
    payload: req.body ?? {},
    signature: req.get('x-plivo-signature-v3'),
    mainSignature: req.get('x-plivo-signature-ma-v3'),
    nonce: req.get('x-plivo-signature-v3-nonce'),
  });
  res.status(202).json({ success: true, data });
});

plivoWebhookRouter.post('/hangup', async (req, res) => {
  const parsed = storedHangupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const data = await processInboundPlivoHangup({
      payload: req.body ?? {},
      signature: req.get('x-plivo-signature-v3'),
      mainSignature: req.get('x-plivo-signature-ma-v3'),
      nonce: req.get('x-plivo-signature-v3-nonce'),
    });
    res.json({ success: true, data });
    return;
  }
  const data = await processPlivoCallback({
    attemptId: parsed.data.attempt_id,
    eventType: 'hangup',
    payload: req.body ?? {},
    signature: req.get('x-plivo-signature-v3'),
    mainSignature: req.get('x-plivo-signature-ma-v3'),
    nonce: req.get('x-plivo-signature-v3-nonce'),
    useStoredUrl: true,
  });
  res.json({ success: true, data });
});

plivoWebhookRouter.post('/calls/:attemptId/:eventType', async (req, res) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) throw new AppError(400, 'Invalid callback path', 'VALIDATION_ERROR');
  const data = await processPlivoCallback({
    ...parsed.data,
    payload: req.body ?? {},
    signature: req.get('x-plivo-signature-v3'),
    mainSignature: req.get('x-plivo-signature-ma-v3'),
    nonce: req.get('x-plivo-signature-v3-nonce'),
  });
  res.json({ success: true, data });
});
