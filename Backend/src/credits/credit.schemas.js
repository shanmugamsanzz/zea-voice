import { z } from 'zod';

const amount = z.union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)
    && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1_000_000_000_000, {
    message: 'Amount must be a positive number with at most 4 decimal places',
  });

const wholeCreditAmount = z.union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), {
    message: 'Credit amount must be a positive whole number',
  });

export const purchaseCreditsSchema = z.object({
  amount,
  reference: z.string().trim().max(240).optional(),
  description: z.string().trim().max(500).optional(),
});
export const allocateCreditsSchema = purchaseCreditsSchema;
export const adjustCreditsSchema = z.object({
  direction: z.enum(['credit', 'debit']),
  amount: wholeCreditAmount,
  type: z.enum(['manual_adjustment', 'promotional_credit', 'refund']).default('manual_adjustment'),
  reference: z.string().trim().max(240).optional(),
  description: z.string().trim().min(1).max(500),
});
export const pricingSchema = z.object({
  inboundRate: amount,
  outboundRate: amount,
});
export const companyCreditIdSchema = z.object({ companyId: z.string().uuid() });
export const ledgerQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  type: z.enum(['platform_purchase', 'company_allocation', 'manual_adjustment', 'promotional_credit', 'usage_debit', 'refund']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const creditThresholdSchema = z.object({
  lowCreditThreshold: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const paymentQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseCreditInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
