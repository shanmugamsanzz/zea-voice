import { z } from 'zod';

export const runtimeKnowledgeQuerySchema = z.object({
  agentId: z.string().uuid(),
  query: z.string().trim().min(1).max(2000),
  usageDirection: z.enum(['inbound', 'outbound']),
  language: z.string().trim().min(2).max(20).default('en'),
  routeHint: z.enum(['auto', 'workflow', 'conversation', 'catalog', 'faq', 'semantic']).default('auto'),
  intent: z.string().trim().min(1).max(160).optional(),
  detectedIntent: z.object({
    intent: z.enum(['overview', 'category_request', 'details', 'price', 'comparison', 'scenario', 'booking_request', 'booking_field_answer', 'side_question', 'confirmation', 'unclear']),
    confidence: z.number().min(0).max(1),
    signals: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  }).optional(),
  flowKey: z.string().trim().min(1).max(160).optional(),
  nodeKey: z.string().trim().min(1).max(160).optional(),
  currentStage: z.string().trim().min(1).max(80).optional(),
  selectedCatalogItemId: z.string().uuid().optional(),
  currentTopic: z.string().trim().min(1).max(240).optional(),
  pendingQuestion: z.string().trim().min(1).max(500).optional(),
  activeCategoryKey: z.string().trim().min(1).max(160).optional(),
  activeCategoryName: z.string().trim().min(1).max(240).optional(),
  selectedCatalogItemKey: z.string().trim().min(1).max(160).optional(),
  selectedCatalogItemName: z.string().trim().min(1).max(240).optional(),
  candidateItemKeys: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  topK: z.coerce.number().int().min(1).max(10).optional(),
}).strict();
