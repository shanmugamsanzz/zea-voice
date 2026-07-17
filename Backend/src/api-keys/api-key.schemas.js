import { z } from 'zod';

export const API_KEY_SCOPES = [
  '*',
  'companies:read', 'companies:write',
  'developers:read', 'developers:write',
  'providers:read', 'providers:write',
  'phone_numbers:read', 'phone_numbers:write',
  'credits:read', 'credits:write',
  'queues:read', 'queues:write',
  'payments:read', 'payments:write',
  'settings:read', 'settings:write',
  'dashboard:read',
  'users:read', 'users:write',
  'agents:read', 'agents:write',
  'campaigns:read', 'campaigns:write',
  'knowledge_bases:read', 'knowledge_bases:write',
  'calls:read', 'calls:create',
  'reports:read',
];

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(160),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).default(['*'])
    .transform((scopes) => [...new Set(scopes)]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export const apiKeyIdSchema = z.object({ apiKeyId: z.string().uuid() });
export const revokeApiKeySchema = z.object({
  reason: z.string().trim().min(3).max(300).default('Revoked by owner'),
});
export const rotateApiKeySchema = z.object({
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export function parseApiKeyInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
