import { z } from 'zod';

export const vqaReportSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export function parseVqaReportInput(value) {
  const result = vqaReportSchema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, issues: result.error.issues.map((issue) => ({
      field: issue.path.join('.'), message: issue.message,
    })) };
}
