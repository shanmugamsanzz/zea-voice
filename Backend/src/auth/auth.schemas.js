import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(200),
  tenantId: z.string().uuid().optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(32).optional(),
});

export function parseRequest(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  return { success: true, data: result.data };
}
