import { Router } from 'express';
import { authenticateRequest } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { parseInsightReportInput } from './insight.schemas.js';
import { getTenantInsights } from './insight.service.js';

export const insightRouter = Router();
insightRouter.use(authenticateRequest, requireTenantContext);
insightRouter.get('/', async (request, response) => {
  const parsed = parseInsightReportInput(request.query);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  response.json({ success: true, data: await getTenantInsights(request.auth, parsed.data) });
});
