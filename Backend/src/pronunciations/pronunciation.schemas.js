import { z } from 'zod';

export const PRONUNCIATION_MATCH_TYPES = Object.freeze(['exact', 'whole_word']);
export const PRONUNCIATION_GROUP_STATUSES = Object.freeze(['active', 'inactive', 'archived']);
export const PRONUNCIATION_RULE_DEFAULTS = Object.freeze({
  matchType: 'whole_word',
  caseSensitive: false,
  priority: 100,
  enabled: true,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const pronunciationText = (label) => z.string()
  .trim()
  .min(1, `${label} is required`)
  .max(500, `${label} must not exceed 500 characters`)
  .refine((value) => !CONTROL_CHARACTERS.test(value), `${label} must not contain control characters`)
  .transform((value) => value.normalize('NFC'));

const ruleFields = {
  sourceText: pronunciationText('Written text'),
  spokenText: pronunciationText('Spoken replacement'),
  matchType: z.enum(PRONUNCIATION_MATCH_TYPES).default(PRONUNCIATION_RULE_DEFAULTS.matchType),
  caseSensitive: z.boolean().default(PRONUNCIATION_RULE_DEFAULTS.caseSensitive),
  priority: z.number().int().min(0).max(10_000).default(PRONUNCIATION_RULE_DEFAULTS.priority),
  enabled: z.boolean().default(PRONUNCIATION_RULE_DEFAULTS.enabled),
};

export const createPronunciationRuleSchema = z.object(ruleFields).strict();

export const updatePronunciationRuleSchema = z.object({
  sourceText: pronunciationText('Written text'),
  spokenText: pronunciationText('Spoken replacement'),
  matchType: z.enum(PRONUNCIATION_MATCH_TYPES),
  caseSensitive: z.boolean(),
  priority: z.number().int().min(0).max(10_000),
  enabled: z.boolean(),
})
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const pronunciationGroupIdSchema = z.object({ groupId: z.string().uuid() }).strict();
export const pronunciationRuleIdSchema = z.object({
  groupId: z.string().uuid(),
  ruleId: z.string().uuid(),
}).strict();

const languageTag = z.string().trim().min(1).max(35)
  .regex(/^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i, 'Use a valid language tag such as ta-IN, en-US, or und');

const groupFields = {
  name: z.string().trim().min(1).max(160),
  language: languageTag,
  status: z.enum(PRONUNCIATION_GROUP_STATUSES),
  description: z.string().trim().max(1000).nullable(),
};

export const createPronunciationGroupSchema = z.object({
  ...groupFields,
  language: languageTag.default('und'),
  status: z.enum(PRONUNCIATION_GROUP_STATUSES).default('active'),
  description: z.string().trim().max(1000).nullable().default(null),
}).strict();

export const updatePronunciationGroupSchema = z.object(groupFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const listPronunciationGroupsSchema = z.object({
  search: z.string().trim().max(160).optional(),
  language: languageTag.optional(),
  status: z.enum(PRONUNCIATION_GROUP_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const replaceAgentPronunciationGroupsSchema = z.object({
  groupIds: z.array(z.string().uuid()).max(50)
    .transform((groupIds) => [...new Set(groupIds)]),
}).strict();

export const pronunciationPreviewSchema = z.object({
  text: z.string().trim().min(1).max(300),
  groupIds: z.array(z.string().uuid()).max(50)
    .transform((groupIds) => [...new Set(groupIds)]).optional(),
}).strict();

export function parsePronunciationInput(schema, value) {
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
