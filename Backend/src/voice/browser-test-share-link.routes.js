import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errors.js';
import { endPublicBrowserTestSession, getPublicBrowserTestShareLink, createPublicBrowserTestSession } from './browser-test-share-link.service.js';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u);
const sessionSchema = z.object({ direction: z.enum(['inbound', 'outbound']).optional() }).strict();
const idSchema = z.string().uuid();
const valid = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR',
    parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
};

export const browserTestShareLinkRouter = Router();
browserTestShareLinkRouter.get('/:token', async (request, response) => {
  response.json({ success: true, data: await getPublicBrowserTestShareLink(valid(tokenSchema, request.params.token)) });
});
browserTestShareLinkRouter.post('/:token/sessions', async (request, response) => {
  const data = await createPublicBrowserTestSession(valid(tokenSchema, request.params.token),
    valid(sessionSchema, request.body ?? {}));
  response.status(201).json({ success: true, data });
});
browserTestShareLinkRouter.delete('/:token/sessions/:testCallId', async (request, response) => {
  response.json({ success: true, data: await endPublicBrowserTestSession(
    valid(tokenSchema, request.params.token), valid(idSchema, request.params.testCallId),
  ) });
});
