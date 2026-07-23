import { z } from 'zod';

export const insightReportSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export function parseInsightReportInput(value) {
  const result = insightReportSchema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, issues: result.error.issues.map((issue) => ({
      field: issue.path.join('.'), message: issue.message,
    })) };
}
