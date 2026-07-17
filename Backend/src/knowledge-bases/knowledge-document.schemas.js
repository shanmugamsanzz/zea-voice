import { z } from 'zod';

export const KNOWLEDGE_DOCUMENT_TYPES = [
  'faq',
  'catalog',
  'workflow_rules',
  'conversation_script',
  'general_knowledge',
];

function parseMetadata(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const uploadKnowledgeDocumentSchema = z.object({
  documentType: z.enum(KNOWLEDGE_DOCUMENT_TYPES),
  displayName: z.string().trim().min(1).max(240).optional(),
  metadata: z.preprocess(parseMetadata, z.record(z.string(), z.unknown()).default({})),
}).strict();

export const uploadKnowledgeDocumentVersionSchema = z.object({
  displayName: z.string().trim().min(1).max(240).optional(),
  metadata: z.preprocess(parseMetadata, z.record(z.string(), z.unknown()).default({})),
}).strict();

export const knowledgeDocumentParamsSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
});

export const knowledgeVersionParamsSchema = z.object({
  knowledgeBaseId: z.string().uuid(),
  documentId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
});

export const listKnowledgeDocumentsSchema = z.object({
  documentType: z.enum(KNOWLEDGE_DOCUMENT_TYPES).optional(),
  status: z.enum([
    'uploading', 'queued', 'processing', 'review_required', 'ready',
    'failed', 'archived', 'deleting', 'deleted',
  ]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseKnowledgeDocumentInput(schema, value) {
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
