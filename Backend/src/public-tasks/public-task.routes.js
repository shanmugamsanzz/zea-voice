import { Router } from 'express';
import { authenticateRequest, requireRoles, requireScopes } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { idempotencyKeySchema, parsePublicTaskInput, publicTaskSchema } from './public-task.schemas.js';
import { createPublicTask } from './public-task.service.js';

function valid(schema, value) {
  const parsed = parsePublicTaskInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

function requireCompanyApiKey(request, _response, next) {
  if (request.auth?.authType !== 'api_key') {
    next(new AppError(403, 'A company API key is required', 'COMPANY_API_KEY_REQUIRED'));
    return;
  }
  next();
}

export const publicTaskRouter = Router();
publicTaskRouter.use(
  authenticateRequest,
  requireCompanyApiKey,
  requireRoles('COMPANY_DEVELOPER'),
  requireScopes('calls:create'),
  requireTenantContext,
);

publicTaskRouter.post('/task', async (request, response) => {
  const idempotencyKey = valid(idempotencyKeySchema, request.headers['idempotency-key']);
  const input = valid(publicTaskSchema, request.body);
  const data = await createPublicTask(request.auth, idempotencyKey, input);
  response.status(data.created ? 201 : 200).json({ success: true, data });
});
