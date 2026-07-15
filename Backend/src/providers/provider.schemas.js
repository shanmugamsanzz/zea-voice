import { z } from 'zod';

const providerType = z.enum(['llm', 'tts', 'stt']);
const providerStatus = z.enum(['connected', 'disconnected', 'error']);

export const createProviderSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: providerType,
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
  status: z.enum(['active', 'inactive']).default('active'),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const modelIdSchema = z.object({ modelId: z.string().uuid() });
export const modelStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });

export function parseProviderInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
