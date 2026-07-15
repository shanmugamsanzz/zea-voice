import { z } from 'zod';

export const createDeveloperSchema = z.object({
  companyId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(200),
  role: z.enum(['COMPANY_DEVELOPER', 'COMPANY_USER', 'company_developer', 'company_user'])
    .transform((value) => value.toLowerCase()).default('company_developer'),
});

export const developerIdSchema = z.object({ developerId: z.string().uuid() });

export const developerStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'inactive']).transform((value) => (
    value === 'inactive' ? 'suspended' : value
  )),
});

export const updateDeveloperSchema = z.object({
  companyId: z.string().uuid().optional(),
  fullName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()).optional(),
  role: z.enum(['COMPANY_DEVELOPER', 'COMPANY_USER', 'company_developer', 'company_user'])
    .transform((value) => value.toLowerCase()).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const listDevelopersSchema = z.object({
  search: z.string().trim().max(200).optional(),
  companyId: z.string().uuid().optional(),
  status: z.enum(['active', 'suspended', 'invited']).optional(),
  role: z.enum(['COMPANY_DEVELOPER', 'COMPANY_USER', 'company_developer', 'company_user'])
    .transform((value) => value.toLowerCase()).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseDeveloperInput(schema, value) {
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
