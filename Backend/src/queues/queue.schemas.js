import { z } from 'zod';

export const queueNameSchema = z.object({
  queueName: z.enum(['batch-calls', 'realtime-calls', 'call-retries']),
});
export const flushQueueSchema = z.object({
  confirm: z.literal(true),
  reason: z.string().trim().min(3).max(300),
});

export function parseQueueInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
