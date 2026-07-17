import { z } from 'zod';

const historyMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(10000),
}).strict();
const contextValue = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]);

export const agentRuntimeResponseSchema = z.object({
  event: z.enum(['user_message', 'welcome', 'inactivity']).default('user_message'),
  query: z.string().trim().min(1).max(2000).optional(),
  usageDirection: z.enum(['inbound', 'outbound']),
  language: z.string().trim().min(2).max(20).optional(),
  routeHint: z.enum(['auto', 'workflow', 'conversation', 'catalog', 'faq', 'semantic']).default('auto'),
  intent: z.string().trim().min(1).max(160).optional(),
  flowKey: z.string().trim().min(1).max(160).optional(),
  nodeKey: z.string().trim().min(1).max(160).optional(),
  topK: z.coerce.number().int().min(1).max(10).optional(),
  history: z.array(historyMessage).max(50).default([]),
  context: z.record(z.string().trim().min(1).max(100), contextValue).default({}),
}).strict().superRefine((value, context) => {
  if (value.event === 'user_message' && !value.query) {
    context.addIssue({ code: 'custom', path: ['query'], message: 'Query is required for a user message' });
  }
});
