import { z } from 'zod';

const optionalText = (maximum) => z.string().trim().max(maximum).optional().nullable();
const statusSchema = z.enum(['pending', 'active', 'suspended', 'archived']);
const billingTierSchema = z.enum(['starter', 'pro', 'enterprise']);

const limitsShape = {
  maxCampaignConcurrency: z.number().int().min(1).max(20).default(20),
  maxTotalConcurrency: z.number().int().min(1).max(10_000).default(20),
  maxAgents: z.number().int().min(0).max(100_000).default(50),
  maxUsers: z.number().int().min(0).max(100_000).default(50),
  maxPhoneNumbers: z.number().int().min(0).max(100_000).default(20),
  maxCampaigns: z.number().int().min(0).max(1_000_000).default(100),
};

const limitsSchema = z.object(limitsShape).refine(
  (value) => value.maxCampaignConcurrency <= value.maxTotalConcurrency,
  { message: 'Campaign concurrency cannot exceed company total concurrency', path: ['maxCampaignConcurrency'] },
);

export const createCompanySchema = z.object({
  businessName: z.string().trim().min(1).max(200),
  legalName: optionalText(240),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  businessPhone: z.string().trim().min(1).max(40),
  website: optionalText(500),
  billingTier: billingTierSchema.default('starter'),
  perMinutePrice: z.number().finite().min(0).max(1_000_000),
  addressLine1: optionalText(300),
  addressLine2: optionalText(300),
  state: optionalText(120),
  country: optionalText(120),
  postalCode: optionalText(30),
  timezone: z.string().trim().min(1).max(64),
  workspaceName: z.string().trim().min(1).max(160).default('Default Workspace'),
  status: z.enum(['pending', 'active']).default('active'),
  locale: z.string().trim().min(2).max(20).default('en-US'),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default('USD'),
  limits: limitsSchema.default({
    maxCampaignConcurrency: 20,
    maxTotalConcurrency: 20,
    maxAgents: 50,
    maxUsers: 50,
    maxPhoneNumbers: 20,
    maxCampaigns: 100,
  }),
});

export const updateCompanySchema = z.object({
  businessName: z.string().trim().min(1).max(200).optional(),
  legalName: optionalText(240),
  firstName: optionalText(100),
  lastName: optionalText(100),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()).optional(),
  businessPhone: optionalText(40),
  website: optionalText(500),
  billingTier: billingTierSchema.optional(),
  perMinutePrice: z.number().finite().min(0).max(1_000_000).optional(),
  addressLine1: optionalText(300),
  addressLine2: optionalText(300),
  state: optionalText(120),
  country: optionalText(120),
  postalCode: optionalText(30),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(20).optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
  limits: z.object(limitsShape).partial().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const companyStatusSchema = z.object({ status: statusSchema });

export const companyIdSchema = z.object({ companyId: z.string().uuid() });

export const listCompaniesSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: statusSchema.optional(),
  billingTier: billingTierSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseCompanyInput(schema, value) {
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
