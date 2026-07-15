import { Router } from 'express';
import { authenticateRequest } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { dashboardQuerySchema, parseDashboardInput } from './dashboard.schemas.js';
import { getCompanyAnalytics, getCompanyDashboard } from './dashboard.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticateRequest, requireTenantContext);
dashboardRouter.get('/', async (req, res) => {
  const parsed = parseDashboardInput(dashboardQuerySchema, req.query);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  const auth = { ...req.auth, tenantId: req.tenant.tenantId, workspaceId: req.tenant.workspaceId };
  res.json({ success: true, data: await getCompanyDashboard(auth, parsed.data.days) });
});
dashboardRouter.get('/analytics', async (req, res) => {
  const parsed = parseDashboardInput(dashboardQuerySchema, req.query);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  const auth = { ...req.auth, tenantId: req.tenant.tenantId, workspaceId: req.tenant.workspaceId };
  res.json({ success: true, data: await getCompanyAnalytics(auth, parsed.data.days) });
});
