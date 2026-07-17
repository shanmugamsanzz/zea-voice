import { z } from 'zod';

const usageDirection = z.enum(['inbound', 'outbound', 'both']);
const knowledgeBaseStatus = z.enum([
  'draft', 'processing', 'ready', 'partially_failed', 'published', 'deleting', 'deleted',
]);

const editableFields = {
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().max(10000).nullable().optional(),
  usageDirection,
  settings: z.record(z.string(), z.unknown()),
};

export const createKnowledgeBaseSchema = z.object({
  ...editableFields,
  usageDirection: usageDirection.default('both'),
  settings: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const updateKnowledgeBaseSchema = z.object(editableFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const knowledgeBaseIdSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
});

export const knowledgeDeletionJobIdSchema = z.object({
  jobId: z.string().uuid(),
});

export const listKnowledgeBasesSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: knowledgeBaseStatus.optional(),
  usageDirection: usageDirection.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseKnowledgeBaseInput(schema, value) {
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
