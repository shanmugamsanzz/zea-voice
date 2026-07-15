import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { createUserSchema, listUsersSchema, parseUserInput, userIdSchema, userStatusSchema } from './user.schemas.js';
import { createCompanyUser, listCompanyUsers, updateCompanyUserStatus } from './user.service.js';

function valid(schema, value) { const parsed = parseUserInput(schema, value); if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues); return parsed.data; }
function auth(req) { return { ...req.auth, tenantId: req.tenant.tenantId, workspaceId: req.tenant.workspaceId }; }
export const userRouter = Router();
userRouter.use(authenticateRequest, requireTenantContext, requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER'));
userRouter.get('/', async (req, res) => res.json({ success: true, data: await listCompanyUsers(auth(req), valid(listUsersSchema, req.query)) }));
userRouter.post('/', async (req, res) => res.status(201).json({ success: true, data: await createCompanyUser(auth(req), valid(createUserSchema, req.body),
  { requestId: req.id, ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null }) }));
userRouter.patch('/:userId/status', async (req, res) => { const { userId } = valid(userIdSchema, req.params); const { status } = valid(userStatusSchema, req.body);
  res.json({ success: true, data: await updateCompanyUserStatus(auth(req), userId, status) }); });
