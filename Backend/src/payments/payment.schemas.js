import { z } from 'zod';

const amount = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value) && Number(value) > 0,
    'Amount must be positive with at most 4 decimal places');
const paymentMethodLabel = z.string().trim().min(1).max(160)
  .refine((value) => !/\d{13,19}/.test(value.replace(/[ -]/g, '')), 'Do not submit a complete card number');

export const paymentIdSchema = z.object({ paymentId: z.string().uuid() });
export const listPaymentsSchema = z.object({
  companyId: z.string().uuid().optional(),
  type: z.enum(['subscription', 'credit_refill', 'add_on']).optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const createPaymentSchema = z.object({
  companyId: z.string().uuid(),
  type: z.enum(['subscription', 'credit_refill', 'add_on']),
  status: z.enum(['pending', 'succeeded', 'failed']).default('pending'),
  amount,
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default('INR'),
  externalReference: z.string().trim().max(240).optional(),
  paymentMethodLabel: paymentMethodLabel.optional(),
  invoiceNumber: z.string().trim().max(120).optional(),
  invoiceObjectKey: z.string().trim().max(1000).optional(),
  failureCode: z.string().trim().max(120).optional(),
  failureMessage: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if (value.status === 'failed' && !value.failureMessage) {
    context.addIssue({ code: 'custom', path: ['failureMessage'], message: 'Failure message is required for failed payments' });
  }
});
export const updatePaymentStatusSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'refunded']),
  failureCode: z.string().trim().max(120).optional(),
  failureMessage: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if (value.status === 'failed' && !value.failureMessage) {
    context.addIssue({ code: 'custom', path: ['failureMessage'], message: 'Failure message is required for failed payments' });
  }
});

export function parsePaymentInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
