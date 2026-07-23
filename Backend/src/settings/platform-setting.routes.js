import { Router } from 'express';
import { authenticateRequest, requireRoles, requireSessionAuthentication } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { parsePlatformSettingInput, updatePlatformSettingsSchema } from './platform-setting.schemas.js';
import { getPlatformSettings, getWorkspaceSettings, updatePlatformSettings } from './platform-setting.service.js';

function valid(schema, value) {
  const parsed = parsePlatformSettingInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const platformSettingRouter = Router();
platformSettingRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
platformSettingRouter.get('/', async (req, res) => res.json({ success: true, data: await getPlatformSettings(req.auth.userId) }));
platformSettingRouter.put('/', requireSessionAuthentication, async (req, res) => res.json({ success: true,
  data: await updatePlatformSettings(req.auth.userId, valid(updatePlatformSettingsSchema, req.body), {
    ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
  }) }));

export const workspaceSettingRouter = Router();
workspaceSettingRouter.use(authenticateRequest, requireTenantContext);
workspaceSettingRouter.get('/', async (req, res) => res.json({
  success: true,
  data: await getWorkspaceSettings({ ...req.auth, tenantId: req.tenant.tenantId, workspaceId: req.tenant.workspaceId }),
}));
