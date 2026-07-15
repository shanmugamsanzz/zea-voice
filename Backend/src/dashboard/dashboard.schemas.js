import { z } from 'zod';

export const dashboardQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(14),
});

export function parseDashboardInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
