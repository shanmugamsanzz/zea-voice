import { z } from 'zod';

export const reviewParamsSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  recordId: z.string().uuid().optional(),
});

export const reviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'reset']),
}).strict();

export const updateReviewRecordSchema = z.object({
  question: z.string().trim().min(1).max(10000).optional(),
  answer: z.string().trim().min(1).max(50000).optional(),
  name: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(50000).nullable().optional(),
  catalogType: z.string().trim().min(1).max(80).optional(),
  defaultCurrency: z.string().trim().length(3).transform((value) => value.toUpperCase()).nullable().optional(),
  price: z.number().min(0).nullable().optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
  language: z.string().trim().min(1).max(20).optional(),
  usageDirection: z.enum(['inbound', 'outbound', 'both']).optional(),
  intent: z.string().trim().min(1).max(160).optional(),
  priority: z.number().int().min(0).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actionType: z.string().trim().min(1).max(120).optional(),
  actionConfig: z.record(z.string(), z.unknown()).optional(),
  responseTemplate: z.string().max(50000).nullable().optional(),
  flowKey: z.string().trim().min(1).max(160).optional(),
  nodeKey: z.string().trim().min(1).max(160).optional(),
  nodeType: z.string().trim().min(1).max(80).optional(),
  sequenceOrder: z.number().int().min(0).optional(),
  isEntry: z.boolean().optional(),
  content: z.string().trim().min(1).max(100000).optional(),
  variables: z.array(z.unknown()).max(1000).optional(),
  transitions: z.array(z.unknown()).max(1000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export function parseKnowledgeReviewInput(schema, value) {
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
