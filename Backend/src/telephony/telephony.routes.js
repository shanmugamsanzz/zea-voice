import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  accountIdSchema, assignPhoneNumberSchema, createTelephonyAccountSchema,
  listPhoneNumbersSchema, mapTenantPhoneAgentSchema, parseTelephonyInput, phoneNumberIdSchema, releasePhoneNumberSchema,
  updateTelephonyAccountSchema,
} from './telephony.schemas.js';
import {
  assignPhoneNumber, createTelephonyAccount, deleteTelephonyAccount, listPhoneNumbers, listTelephonyAccounts,
  listAssignablePhoneOptions, listCompanySubaccounts, listTenantPhoneNumbers, mapTenantPhoneNumberAgent,
  releasePhoneNumber, syncTelephonyAccount, updateTelephonyAccount,
} from './telephony.service.js';

function valid(schema, value) {
  const parsed = parseTelephonyInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const telephonyAdminRouter = Router();
telephonyAdminRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
telephonyAdminRouter.get('/accounts', async (req, res) => res.json({ success: true, data: await listTelephonyAccounts(req.auth.userId) }));
telephonyAdminRouter.get('/subaccounts', async (req, res) => res.json({ success: true, data: await listCompanySubaccounts(req.auth.userId) }));
telephonyAdminRouter.post('/accounts', async (req, res) => res.status(201).json({ success: true, data: await createTelephonyAccount(req.auth.userId, valid(createTelephonyAccountSchema, req.body)) }));
telephonyAdminRouter.patch('/accounts/:accountId', async (req, res) => {
  const { accountId } = valid(accountIdSchema, req.params);
  res.json({ success: true, data: await updateTelephonyAccount(req.auth.userId, accountId, valid(updateTelephonyAccountSchema, req.body)) });
});
telephonyAdminRouter.delete('/accounts/:accountId', async (req, res) => {
  const { accountId } = valid(accountIdSchema, req.params);
  res.json({ success: true, data: await deleteTelephonyAccount(req.auth.userId, accountId) });
});
telephonyAdminRouter.post('/accounts/:accountId/sync', async (req, res) => {
  const { accountId } = valid(accountIdSchema, req.params);
  res.json({ success: true, data: await syncTelephonyAccount(req.auth.userId, accountId) });
});
telephonyAdminRouter.get('/phone-number-options', async (req, res) => res.json({ success: true, data: await listAssignablePhoneOptions(req.auth.userId) }));
telephonyAdminRouter.get('/phone-numbers', async (req, res) => res.json({ success: true, data: await listPhoneNumbers(req.auth.userId, valid(listPhoneNumbersSchema, req.query)) }));
telephonyAdminRouter.post('/phone-numbers/:phoneNumberId/assign', async (req, res) => {
  const { phoneNumberId } = valid(phoneNumberIdSchema, req.params);
  const { companyId } = valid(assignPhoneNumberSchema, req.body);
  res.json({ success: true, data: await assignPhoneNumber(req.auth.userId, phoneNumberId, companyId) });
});
telephonyAdminRouter.post('/phone-numbers/:phoneNumberId/release', async (req, res) => {
  const { phoneNumberId } = valid(phoneNumberIdSchema, req.params);
  const { reason } = valid(releasePhoneNumberSchema, req.body ?? {});
  res.json({ success: true, data: await releasePhoneNumber(req.auth.userId, phoneNumberId, reason) });
});

export const tenantPhoneRouter = Router();
tenantPhoneRouter.use(authenticateRequest, requireTenantContext);
function tenantAuth(req) {
  return { ...req.auth, tenantId: req.tenant.tenantId, workspaceId: req.tenant.workspaceId };
}
tenantPhoneRouter.get('/', async (req, res) => res.json({
  success: true,
  data: await listTenantPhoneNumbers(tenantAuth(req)),
}));
tenantPhoneRouter.put(
  '/:phoneNumberId/agent',
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER'),
  async (req, res) => {
    const { phoneNumberId } = valid(phoneNumberIdSchema, req.params);
    const { agentId } = valid(mapTenantPhoneAgentSchema, req.body);
    res.json({
      success: true,
      data: await mapTenantPhoneNumberAgent(tenantAuth(req), phoneNumberId, agentId),
    });
  },
);
