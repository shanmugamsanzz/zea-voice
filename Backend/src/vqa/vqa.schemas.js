import { z } from 'zod';

export const vqaQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(7),
  auditLimit: z.coerce.number().int().min(1).max(20).default(5),
});

export function parseVqaInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
