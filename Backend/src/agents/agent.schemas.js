import { z } from 'zod';

const fields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).nullable().optional(),
  goal: z.string().trim().max(5000).nullable().optional(),
  language: z.string().trim().min(1).max(80).default('English (US)'),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  phoneNumberId: z.string().uuid().nullable().optional(),
  sttModelId: z.string().uuid(), llmModelId: z.string().uuid(), ttsModelId: z.string().uuid(),
  voiceId: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(100000),
  welcomeMessage: z.string().max(10000).nullable().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  interruptionSensitivity: z.number().min(0).max(1).default(0.3),
  silenceTimeoutMs: z.number().int().min(100).max(120000).default(600),
  inactivityTimeoutSeconds: z.number().int().min(1).max(3600).default(5),
  settings: z.record(z.string(), z.unknown()).default({}),
};
export const createAgentSchema = z.object(fields);
export const updateAgentSchema = z.object(fields).partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const agentIdSchema = z.object({ agentId: z.string().uuid() });
export const agentStatusSchema = z.object({ status: z.enum(['draft', 'active', 'archived']) });
export const listAgentsSchema = z.object({
  search: z.string().trim().max(200).optional(), status: z.enum(['draft', 'active', 'archived']).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export function parseAgentInput(schema, value) { const result = schema.safeParse(value); if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) }; }
