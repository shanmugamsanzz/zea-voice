import { z } from 'zod';

export const callIdSchema = z.object({ callId: z.string().uuid() });
export const listCallsSchema = z.object({
  companyId: z.string().uuid().optional(),
  status: z.enum(['queued', 'ringing', 'connected', 'completed', 'failed', 'busy', 'no_answer', 'canceled']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  search: z.string().trim().max(100).optional(),
  activeOnly: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const forceHangupSchema = z.object({
  confirm: z.literal(true),
  reason: z.string().trim().min(3).max(300),
});

export function parseCallInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
