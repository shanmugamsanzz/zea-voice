import { Router } from 'express';
import { authenticateRequest, requireRoles, requireSessionAuthentication } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  apiKeyIdSchema, createApiKeySchema, parseApiKeyInput, revokeApiKeySchema, rotateApiKeySchema,
} from './api-key.schemas.js';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from './api-key.service.js';

function valid(schema, value) {
  const parsed = parseApiKeyInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const apiKeyRouter = Router();
apiKeyRouter.use(authenticateRequest, requireSessionAuthentication,
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER'));
apiKeyRouter.get('/', async (req, res) => res.json({ success: true, data: await listApiKeys(req.auth) }));
apiKeyRouter.post('/', async (req, res) => res.status(201).json({
  success: true, data: await createApiKey(req.auth, valid(createApiKeySchema, req.body)),
}));
apiKeyRouter.post('/:apiKeyId/revoke', async (req, res) => {
  const { apiKeyId } = valid(apiKeyIdSchema, req.params);
  const { reason } = valid(revokeApiKeySchema, req.body ?? {});
  res.json({ success: true, data: await revokeApiKey(req.auth, apiKeyId, reason) });
});
apiKeyRouter.post('/:apiKeyId/rotate', async (req, res) => {
  const { apiKeyId } = valid(apiKeyIdSchema, req.params);
  res.status(201).json({ success: true, data: await rotateApiKey(req.auth, apiKeyId, valid(rotateApiKeySchema, req.body ?? {})) });
});
