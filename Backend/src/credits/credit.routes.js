import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  adjustCreditsSchema, allocateCreditsSchema, companyCreditIdSchema, ledgerQuerySchema,
  parseCreditInput, pricingSchema, purchaseCreditsSchema,
} from './credit.schemas.js';
import {
  adjustCompanyCredits, allocateCompanyCredits, getAdminCreditSummary, getTenantCredits,
  getProviderCreditBalances, listAdminLedger, purchasePlatformCredits, updatePricing,
} from './credit.service.js';

function valid(schema, value) {
  const parsed = parseCreditInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const creditAdminRouter = Router();
creditAdminRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
creditAdminRouter.get('/summary', async (req, res) => res.json({ success: true, data: await getAdminCreditSummary(req.auth.userId) }));
creditAdminRouter.get('/provider-balances', async (req, res) => res.json({
  success: true,
  data: await getProviderCreditBalances(req.auth.userId, fetch, {
    forceRefresh: req.query.refresh === 'true' || req.get('x-force-provider-refresh') === 'true',
  }),
}));
creditAdminRouter.get('/ledger', async (req, res) => res.json({ success: true, data: await listAdminLedger(req.auth.userId, valid(ledgerQuerySchema, req.query)) }));
creditAdminRouter.post('/platform/purchases', async (req, res) => res.status(201).json({ success: true, data: await purchasePlatformCredits(req.auth.userId, valid(purchaseCreditsSchema, req.body)) }));
creditAdminRouter.post('/companies/:companyId/allocations', async (req, res) => {
  const { companyId } = valid(companyCreditIdSchema, req.params);
  res.status(201).json({ success: true, data: await allocateCompanyCredits(req.auth.userId, companyId, valid(allocateCreditsSchema, req.body)) });
});
creditAdminRouter.post('/companies/:companyId/adjustments', async (req, res) => {
  const { companyId } = valid(companyCreditIdSchema, req.params);
  res.status(201).json({ success: true, data: await adjustCompanyCredits(req.auth.userId, companyId, valid(adjustCreditsSchema, req.body)) });
});
creditAdminRouter.put('/pricing', async (req, res) => res.json({ success: true, data: await updatePricing(req.auth.userId, valid(pricingSchema, req.body)) }));

export const tenantCreditRouter = Router();
tenantCreditRouter.use(authenticateRequest, requireTenantContext);
tenantCreditRouter.get('/', async (req, res) => res.json({ success: true, data: await getTenantCredits(req.auth, valid(ledgerQuerySchema.omit({ companyId: true }), req.query)) }));
