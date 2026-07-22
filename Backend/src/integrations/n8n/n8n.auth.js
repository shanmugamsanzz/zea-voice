import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errors.js';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

export function requireN8nApiKey(request, _response, next) {
  if (!env.N8N_API_KEY) {
    next(new AppError(503, 'n8n integration is not configured', 'N8N_NOT_CONFIGURED'));
    return;
  }
  const supplied = request.get('x-n8n-api-key') ?? '';
  if (!crypto.timingSafeEqual(digest(supplied), digest(env.N8N_API_KEY))) {
    next(new AppError(401, 'Invalid n8n API key', 'N8N_API_KEY_INVALID'));
    return;
  }
  next();
}
