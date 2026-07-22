import { Router } from 'express';
import { AppError } from '../../middleware/errors.js';
import { requireN8nApiKey } from './n8n.auth.js';
import { n8nTriggerCallSchema } from './n8n.schemas.js';
import { triggerN8nCall } from './n8n.service.js';

export const n8nIntegrationRouter = Router();

n8nIntegrationRouter.post('/trigger-call', requireN8nApiKey, async (request, response) => {
  const parsed = n8nTriggerCallSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'), message: issue.message,
    })));
  }
  const data = await triggerN8nCall(parsed.data);
  response.status(201).json({ success: true, data });
});
