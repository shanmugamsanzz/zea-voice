import { Router } from 'express';
import { authenticateRequest } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { getVoiceQualityAssessment } from './vqa.service.js';
import { parseVqaInput, vqaQuerySchema } from './vqa.schemas.js';

export const vqaRouter = Router();
vqaRouter.use(authenticateRequest, requireTenantContext);
vqaRouter.get('/', async (req, res) => {
  const parsed = parseVqaInput(vqaQuerySchema, req.query);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  const auth = { ...req.auth, tenantId: req.tenant.tenantId, workspaceId: req.tenant.workspaceId };
  res.json({ success: true, data: await getVoiceQualityAssessment(auth, parsed.data) });
});
