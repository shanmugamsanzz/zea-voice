import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { getPlatformDashboard } from './platform-dashboard.service.js';

export const platformDashboardRouter = Router();
platformDashboardRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
platformDashboardRouter.get('/', async (request, response) => {
  response.json({ success: true, data: await getPlatformDashboard(request.auth.userId) });
});
