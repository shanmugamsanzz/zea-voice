import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { createPaymentSchema, listPaymentsSchema, parsePaymentInput, paymentIdSchema, updatePaymentStatusSchema } from './payment.schemas.js';
import { createPayment, getPaymentSummary, listPayments, updatePaymentStatus } from './payment.service.js';

function valid(schema, value) {
  const parsed = parsePaymentInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

export const paymentAdminRouter = Router();
paymentAdminRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));
paymentAdminRouter.get('/', async (req, res) => res.json({ success: true, data: await listPayments(req.auth, valid(listPaymentsSchema, req.query)) }));
paymentAdminRouter.get('/summary', async (req, res) => res.json({ success: true, data: await getPaymentSummary(req.auth.userId) }));
paymentAdminRouter.post('/', async (req, res) => res.status(201).json({ success: true, data: await createPayment(req.auth.userId, valid(createPaymentSchema, req.body)) }));
paymentAdminRouter.patch('/:paymentId/status', async (req, res) => {
  const { paymentId } = valid(paymentIdSchema, req.params);
  res.json({ success: true, data: await updatePaymentStatus(req.auth.userId, paymentId, valid(updatePaymentStatusSchema, req.body)) });
});

export const tenantPaymentRouter = Router();
tenantPaymentRouter.use(authenticateRequest, requireTenantContext);
tenantPaymentRouter.get('/', async (req, res) => res.json({ success: true,
  data: await listPayments(req.auth, valid(listPaymentsSchema.omit({ companyId: true }), req.query)) }));
