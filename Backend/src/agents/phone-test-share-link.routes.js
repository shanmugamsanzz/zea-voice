import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errors.js';
import { getPublicPhoneTestLink, requestPublicPhoneTest, getPublicPhoneTestStatus } from './phone-test-share-link.service.js';
import { consumePhoneShareReadLimit } from './phone-test-share-rate-limit.js';
const valid = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, 'Invalid calling request.', 'VALIDATION_ERROR');
  return parsed.data;
};
const token = req => {
  const value = req.get('x-phone-test-share-token');
  if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? '')) throw new AppError(404, 'This calling link is unavailable or expired.', 'PHONE_SHARE_LINK_UNAVAILABLE');
  return value;
};
export const publicPhoneTestShareRouter = Router();
publicPhoneTestShareRouter.use(async (req, res, next) => {
  res.set('Cache-Control','no-store').set('Referrer-Policy','no-referrer');
  try { await consumePhoneShareReadLimit(req.ip ?? req.socket.remoteAddress); next(); }
  catch (error) { if (error.statusCode === 429) res.set('Retry-After', String(error.details.retryAfterSeconds)); next(error); }
});
publicPhoneTestShareRouter.get('/', async (req, res) => {
  res.json({ success: true, data: await getPublicPhoneTestLink(token(req)) });
});
publicPhoneTestShareRouter.post('/calls', async (req, res) => {
  const input = valid(z.object({ phone: z.string().trim().min(7).max(40), requestId: z.string().uuid(),
    consent: z.literal(true), website: z.string().max(0).optional() }).strict(), req.body);
  try {
    res.status(201).json({ success: true, data: await requestPublicPhoneTest(token(req), input, req.ip ?? req.socket.remoteAddress) });
  } catch (error) {
    if (error.statusCode === 429 && error.details?.retryAfterSeconds) res.set('Retry-After', String(error.details.retryAfterSeconds));
    throw error;
  }
});
publicPhoneTestShareRouter.get('/calls/:requestId', async (req, res) => {
  const id = valid(z.string().uuid(), req.params.requestId);
  const key = valid(z.string().uuid(), req.get('x-phone-test-request-key'));
  res.json({ success: true, data: await getPublicPhoneTestStatus(token(req), id, key) });
});
