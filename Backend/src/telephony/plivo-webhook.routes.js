import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errors.js';
import { processInboundPlivoHangup, processPlivoCallback } from './plivo-webhook.service.js';
import { acceptPlivoRecordingCallback } from './plivo-recording.service.js';
import { validateIncomingPlivoCall } from '../voice/plivo-answer.service.js';
import { voiceCallOwnership } from '../voice/call-ownership.service.js';
import { plivoAnswerPayloadSchema } from '../voice/voice.schemas.js';
import { inboundCallQueue } from '../voice/inbound-call-queue.service.js';

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
  if (req.query.capacity_id !== undefined) {
    const capacityQuery = z.object({ capacity_id: z.string().uuid() }).safeParse(req.query);
    const parsedPayload = plivoAnswerPayloadSchema.safeParse(req.body ?? {});
    if (!capacityQuery.success || !parsedPayload.success) {
      throw new AppError(400, 'Invalid call capacity callback', 'VALIDATION_ERROR');
    }
    const reservationId = capacityQuery.data.capacity_id;
    const normalizedPayload = parsedPayload.data;
    const call = await validateIncomingPlivoCall({
      payload: normalizedPayload, rawPayload: req.body ?? {}, callbackType: 'hangup', reservationId,
      signature: req.get('x-plivo-signature-v3'), mainSignature: req.get('x-plivo-signature-ma-v3'),
      nonce: req.get('x-plivo-signature-v3-nonce'),
    });
    if (!call.capacityTenantId || call.direction !== 'outbound') {
      throw new AppError(409, 'Outbound call company could not be resolved', 'VOICE_CALL_OWNERSHIP_CONFLICT');
    }
    try {
      await voiceCallOwnership.releaseReservation({ tenantId: call.capacityTenantId, reservationId });
      await voiceCallOwnership.releaseValidated({ tenantId: call.capacityTenantId, providerCallId: call.providerCallId });
    } catch (error) {
      req.log.warn({ err: error, stage: 'call.capacity_release_failed', reservationId }, 'Call capacity will recover on lease expiry');
    }
    try {
      const data = await processInboundPlivoHangup({
        payload: req.body ?? {}, reservationId,
        signature: req.get('x-plivo-signature-v3'), mainSignature: req.get('x-plivo-signature-ma-v3'),
        nonce: req.get('x-plivo-signature-v3-nonce'),
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error.code !== 'CALL_SESSION_NOT_FOUND') throw error;
      res.json({ success: true, data: { status: 'released' } });
    }
    return;
  }
  const parsed = storedHangupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const input = {
      payload: req.body ?? {},
      signature: req.get('x-plivo-signature-v3'),
      mainSignature: req.get('x-plivo-signature-ma-v3'),
      nonce: req.get('x-plivo-signature-v3-nonce'),
    };
    let data;
    try {
      data = await processInboundPlivoHangup(input);
      await inboundCallQueue.cancel({ tenantId: data.tenantId, providerCallId: input.payload.CallUUID })
        .catch(error => req.log.warn({ err: error, stage: 'call.inbound_queue_cleanup_failed' }, 'Inbound queue cleanup deferred to lease expiry'));
    } catch (error) {
      if (error.code !== 'CALL_SESSION_NOT_FOUND') throw error;
      const payload = plivoAnswerPayloadSchema.safeParse(input.payload);
      if (!payload.success || (payload.data.Direction ?? 'inbound') !== 'inbound') throw error;
      const call = await validateIncomingPlivoCall({ ...input, payload: payload.data,
        rawPayload: input.payload, callbackType: 'hangup' });
      if (!call.capacityTenantId) throw error;
      await inboundCallQueue.cancel({ tenantId: call.capacityTenantId, providerCallId: call.providerCallId });
      data = { status: 'ended', waiting: true };
    }
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
