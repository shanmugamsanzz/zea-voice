import { Router } from 'express';
import { authenticateRequest } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { parseVqaReportInput } from './vqa.schemas.js';
import { getTenantVqaReport } from './vqa.service.js';

export const vqaRouter = Router();
vqaRouter.use(authenticateRequest, requireTenantContext);
vqaRouter.get('/', async (request, response) => {
  const parsed = parseVqaReportInput(request.query);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  response.json({ success: true, data: await getTenantVqaReport(request.auth, parsed.data) });
});
