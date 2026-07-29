import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  adjustCreditsSchema, allocateCreditsSchema, companyCreditIdSchema, creditThresholdSchema, ledgerQuerySchema,
  parseCreditInput, paymentQuerySchema,
} from './credit.schemas.js';
import {
  adjustCompanyCredits, allocateCompanyCredits, getAdminCreditSummary, getTenantCredits,
  getProviderCreditBalances, listAdminLedger, listAdminPayments, previewCompanyCreditPurchase,
  updateGlobalCreditThreshold,
} from './credit.service.js';

function valid(schema, value) {
  const parsed = parseCreditInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const creditAdminRouter = Router();
creditAdminRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
creditAdminRouter.get('/summary', async (req, res) => res.json({ success: true, data: await getAdminCreditSummary(req.auth.userId) }));
creditAdminRouter.put('/threshold', async (req, res) => res.json({
  success: true,
  data: await updateGlobalCreditThreshold(req.auth.userId, valid(creditThresholdSchema, req.body)),
}));
creditAdminRouter.get('/provider-balances', async (req, res) => res.json({
  success: true,
  data: await getProviderCreditBalances(req.auth.userId, fetch, {
    forceRefresh: req.query.refresh === 'true' || req.get('x-force-provider-refresh') === 'true',
  }),
}));
creditAdminRouter.get('/ledger', async (req, res) => res.json({ success: true, data: await listAdminLedger(req.auth.userId, valid(ledgerQuerySchema, req.query)) }));
creditAdminRouter.get('/payments', async (req, res) => res.json({ success: true, data: await listAdminPayments(req.auth.userId, valid(paymentQuerySchema, req.query)) }));
creditAdminRouter.post('/companies/:companyId/allocations', async (req, res) => {
  const { companyId } = valid(companyCreditIdSchema, req.params);
  const key = String(req.get('idempotency-key') ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) {
    throw new AppError(400, 'A valid Idempotency-Key header is required', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  res.status(201).json({
    success: true,
    data: await allocateCompanyCredits(req.auth.userId, companyId, valid(allocateCreditsSchema, req.body), key),
  });
});
creditAdminRouter.post('/companies/:companyId/allocations/preview', async (req, res) => {
  const { companyId } = valid(companyCreditIdSchema, req.params);
  res.json({
    success: true,
    data: await previewCompanyCreditPurchase(req.auth.userId, companyId, valid(allocateCreditsSchema, req.body)),
  });
});
creditAdminRouter.post('/companies/:companyId/adjustments', async (req, res) => {
  const { companyId } = valid(companyCreditIdSchema, req.params);
  res.status(201).json({ success: true, data: await adjustCompanyCredits(req.auth.userId, companyId, valid(adjustCreditsSchema, req.body)) });
});

export const tenantCreditRouter = Router();
tenantCreditRouter.use(authenticateRequest, requireTenantContext);
tenantCreditRouter.get('/', async (req, res) => res.json({ success: true, data: await getTenantCredits(req.auth, valid(ledgerQuerySchema.omit({ companyId: true }), req.query)) }));
