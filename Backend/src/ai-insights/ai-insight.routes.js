import { Router } from 'express';
import {
  authenticateRequest,
  requireRoles,
  requireSessionAuthentication,
} from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { getAiInsights, reviewInsightCall } from './ai-insight.service.js';
import {
  aiInsightQuerySchema,
  aiInsightReviewBodySchema,
  aiInsightReviewParamsSchema,
  parseAiInsightInput,
} from './ai-insight.schemas.js';

function valid(schema, value) {
  const parsed = parseAiInsightInput(schema, value);
  if (!parsed.success) {
    throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  }
  return parsed.data;
}

function tenantAuth(request) {
  return {
    ...request.auth,
    tenantId: request.tenant.tenantId,
    workspaceId: request.tenant.workspaceId,
  };
}

export const aiInsightRouter = Router();
aiInsightRouter.use(authenticateRequest, requireTenantContext);

aiInsightRouter.get('/', async (request, response) => {
  const filters = valid(aiInsightQuerySchema, request.query);
  response.json({ success: true, data: await getAiInsights(tenantAuth(request), filters) });
});

aiInsightRouter.post(
  '/reviews/:callId',
  requireSessionAuthentication,
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER'),
  async (request, response) => {
    const params = valid(aiInsightReviewParamsSchema, request.params);
    const input = valid(aiInsightReviewBodySchema, request.body);
    response.status(201).json({
      success: true,
      data: await reviewInsightCall(tenantAuth(request), params.callId, input),
    });
  },
);
