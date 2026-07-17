import { z } from 'zod';

export const runtimeKnowledgeQuerySchema = z.object({
  agentId: z.string().uuid(),
  query: z.string().trim().min(1).max(2000),
  usageDirection: z.enum(['inbound', 'outbound']),
  language: z.string().trim().min(2).max(20).default('en'),
  routeHint: z.enum(['auto', 'workflow', 'conversation', 'catalog', 'faq', 'semantic']).default('auto'),
  intent: z.string().trim().min(1).max(160).optional(),
  flowKey: z.string().trim().min(1).max(160).optional(),
  nodeKey: z.string().trim().min(1).max(160).optional(),
  topK: z.coerce.number().int().min(1).max(10).optional(),
}).strict();
