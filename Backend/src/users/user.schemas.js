import { z } from 'zod';

export const createUserSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(200),
});
export const userIdSchema = z.object({ userId: z.string().uuid() });
export const userStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'inactive']).transform((value) => (
    value === 'inactive' ? 'suspended' : value
  )),
});
export const listUsersSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'suspended', 'invited']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseUserInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
