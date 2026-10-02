import { z } from 'zod';
import { providerTypes } from './runtime-connection-types.js';

const providerType = z.enum(providerTypes);
const providerStatus = z.enum(['connected', 'disconnected', 'error']);
const runtimeConnectionType = z.string().trim().min(1).max(80);

export const createProviderSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: providerType,
  runtimeConnectionType: runtimeConnectionType.optional(),
  status: providerStatus.default('disconnected'),
  baseUrl: z.string().trim().url().max(1000).optional().nullable(),
  latencyMs: z.number().int().min(0).optional().nullable(),
  parameters: z.array(z.object({
    key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(160),
    value: z.string().max(20_000),
    isSecret: z.boolean().default(true),
  })).max(100).default([]),
});

export const providerIdSchema = z.object({ providerId: z.string().uuid() });
export const providerStatusSchema = z.object({ status: providerStatus });
export const updateProviderSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  status: providerStatus.optional(),
  baseUrl: z.string().trim().url().max(1000).optional().nullable(),
  latencyMs: z.number().int().min(0).optional().nullable(),
  runtimeConnectionType: runtimeConnectionType.optional(),
  parameters: z.array(z.object({
    originalKey: z.string().trim().max(160).optional(),
    key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(160),
    value: z.string().min(1).max(20_000).optional(),
    isSecret: z.boolean(),
  })).max(100).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const listProvidersSchema = z.object({
  type: providerType.optional(),
  status: providerStatus.optional(),
  search: z.string().trim().max(200).optional(),
});

export const createModelSchema = z.object({
  modelKey: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(240),
  voiceId: z.string().trim().min(1).max(240).optional(),
  language: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateModelSchema = z.object({
  modelKey: z.string().trim().min(1).max(240).optional(),
  displayName: z.string().trim().min(1).max(240).optional(),
  voiceId: z.string().trim().min(1).max(240).optional(),
  language: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const modelIdSchema = z.object({ modelId: z.string().uuid() });
export const modelStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });
export const modelPriceIdSchema = z.object({ priceId: z.string().uuid() });

const priceParameterSchema = z.object({
  parameterName: z.string().trim().min(1).max(120),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  unitName: z.string().trim().min(1).max(120),
  unitQuantity: z.number().positive().max(1_000_000_000_000),
  price: z.number().min(0).max(1_000_000_000_000),
  effectiveDate: z.string().date().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const createModelPricesSchema = z.object({
  providerId: z.string().uuid(),
  parameters: z.array(priceParameterSchema).min(1).max(50),
}).superRefine((value, context) => {
  const names = new Set();
  for (const [index, parameter] of value.parameters.entries()) {
    const key = parameter.parameterName.toLocaleLowerCase();
    if (names.has(key)) context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parameters', index, 'parameterName'],
      message: 'Each price parameter name can appear only once in one request',
    });
    names.add(key);
  }
});

export const updateModelPriceSchema = priceParameterSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one price field is required' },
);

export const modelPriceStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });
export const modelPriceHistorySchema = z.object({
  parameterName: z.string().trim().min(1).max(120),
});

export function parseProviderInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
