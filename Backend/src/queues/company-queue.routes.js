import { Router } from 'express';
import { z } from 'zod';
import { authenticateRequest, requireRoles, requireSessionAuthentication } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { getCompanyQueue, cancelCompanyQueuedTask } from './company-queue.service.js';
import { transitionCampaign } from '../campaigns/campaign.service.js';
import { wakePausedCampaignTasks } from '../campaigns/campaign-execution.service.js';
import { requireCompanyCallQueueEnabled } from './company-queue-feature.js';
import { cancelCompanyPhoneTest } from '../agents/agent-phone-test-queue.service.js';

const context = request => ({ ...request.auth, ...request.tenant });
function valid(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, 'Invalid queue request', 'VALIDATION_ERROR');
  return parsed.data;
}
const developers = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER');
export const companyQueueRouter = Router();
companyQueueRouter.use(authenticateRequest, requireSessionAuthentication, requireTenantContext);
companyQueueRouter.get('/', async (req, res) => {
  const filters = valid(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).strict(), req.query);
  res.json({ success: true, data: await getCompanyQueue(context(req), filters) });
});
companyQueueRouter.post('/tasks/:taskId/cancel', developers, async (req, res) => {
  const { taskId } = valid(z.object({ taskId: z.string().uuid() }), req.params);
  res.json({ success: true, data: await cancelCompanyQueuedTask(context(req), taskId) });
});
companyQueueRouter.post('/phone-tests/:requestId/cancel', developers, async (req, res) => {
  const { requestId } = valid(z.object({ requestId: z.string().uuid() }), req.params);
  res.json({ success: true, data: await cancelCompanyPhoneTest(context(req), requestId) });
});
companyQueueRouter.post('/campaigns/:campaignId/:action', developers, async (req, res) => {
  const { campaignId, action } = valid(z.object({ campaignId: z.string().uuid(), action: z.enum(['pause', 'resume']) }), req.params);
  const auth = context(req);
  requireCompanyCallQueueEnabled(auth.tenantId);
  const data = await transitionCampaign(auth, campaignId, action);
  if (action === 'resume') await wakePausedCampaignTasks(auth.tenantId, campaignId);
  res.json({ success: true, data });
});
