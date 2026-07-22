import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { getTenantIdentitySettings } from './tenant-setting.service.js';

function tenantAuth(request) {
  return {
    ...request.auth,
    tenantId: request.tenant.tenantId,
    workspaceId: request.tenant.workspaceId,
  };
}

export const tenantSettingRouter = Router();
tenantSettingRouter.use(
  authenticateRequest,
  requireTenantContext,
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER'),
);
tenantSettingRouter.get('/profile', async (request, response) => {
  response.json({
    success: true,
    data: await getTenantIdentitySettings(tenantAuth(request)),
  });
});
