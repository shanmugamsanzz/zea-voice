import { z } from 'zod';

export const runtimeKnowledgeQuerySchema = z.object({
  agentId: z.string().uuid(),
  query: z.string().trim().min(1).max(2000),
  requestedFacts: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  usageDirection: z.enum(['inbound', 'outbound']),
  language: z.string().trim().min(2).max(20).default('en'),
  currentTopic: z.string().trim().min(1).max(240).optional(),
  pendingQuestion: z.string().trim().min(1).max(500).optional(),
  knownEntities: z.array(z.object({
    key: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(240).optional(),
    category: z.string().trim().min(1).max(240).optional(),
  }).passthrough()).max(30).default([]),
  topK: z.coerce.number().int().min(1).max(10).optional(),
}).strict();
