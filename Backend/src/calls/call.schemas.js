import { z } from 'zod';

export const callIdSchema = z.object({ callId: z.string().uuid() });
const listCallsBaseSchema = z.object({
  companyId: z.string().uuid().optional(),
  status: z.enum(['queued', 'ringing', 'connected', 'completed', 'failed', 'busy', 'no_answer', 'canceled']).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  agentId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  startedFrom: z.iso.datetime({ offset: true }).optional(),
  startedTo: z.iso.datetime({ offset: true }).optional(),
  minDurationSeconds: z.coerce.number().int().min(0).optional(),
  maxDurationSeconds: z.coerce.number().int().min(0).optional(),
  search: z.string().trim().max(100).optional(),
  activeOnly: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean()).default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function withValidReportRanges(schema) {
  return schema.refine((value) => value.minDurationSeconds === undefined || value.maxDurationSeconds === undefined
  || value.minDurationSeconds <= value.maxDurationSeconds, {
  message: 'minDurationSeconds cannot exceed maxDurationSeconds',
  path: ['minDurationSeconds'],
}).refine((value) => value.startedFrom === undefined || value.startedTo === undefined
  || new Date(value.startedFrom) <= new Date(value.startedTo), {
  message: 'startedFrom cannot be after startedTo',
  path: ['startedFrom'],
});
}

export const listCallsSchema = withValidReportRanges(listCallsBaseSchema);
export const listTenantCallsSchema = withValidReportRanges(listCallsBaseSchema.omit({ companyId: true }));
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
