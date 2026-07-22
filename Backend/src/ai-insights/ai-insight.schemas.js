import { z } from 'zod';

const optionalUuid = z.preprocess((value) => value === '' ? undefined : value, z.string().uuid().optional());
const optionalText = (values) => z.preprocess(
  (value) => value === '' ? undefined : value,
  z.enum(values).optional(),
);

export const aiInsightQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
  agentId: optionalUuid,
  campaignId: optionalUuid,
  direction: optionalText(['inbound', 'outbound']),
  status: optionalText(['queued', 'ringing', 'connected', 'completed', 'failed', 'busy', 'no_answer', 'canceled']),
  queueLimit: z.coerce.number().int().min(1).max(50).default(10),
});

export const aiInsightReviewParamsSchema = z.object({
  callId: z.string().uuid(),
});

export const aiInsightReviewBodySchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export function parseAiInsightInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
