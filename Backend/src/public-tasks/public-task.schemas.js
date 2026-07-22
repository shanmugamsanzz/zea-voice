import { z } from 'zod';

const retryInterval = z.number().int().min(1_000).max(604_800_000);

export const publicTaskSchema = z.object({
  agent: z.string().uuid(),
  campaign: z.string().uuid(),
  phone: z.string().trim().min(7).max(40),
  from: z.string().trim().min(7).max(40),
  workspace_id: z.string().uuid(),
  tenant_id: z.string().uuid().optional(),
  organization_id: z.string().uuid().optional(),
  retries: z.number().int().min(0).max(10),
  intervals: z.array(retryInterval).max(10),
  context: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, context) => {
  if (value.intervals.length !== value.retries) {
    context.addIssue({
      code: 'custom', path: ['intervals'],
      message: 'Provide exactly one retry interval for each retry',
    });
  }
  if (JSON.stringify(value.context).length > 50_000) {
    context.addIssue({ code: 'custom', path: ['context'], message: 'Context is too large' });
  }
});

export const idempotencyKeySchema = z.string().trim().min(1).max(200);

export function parsePublicTaskInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      field: issue.path.join('.'), message: issue.message,
    })),
  };
}
