import { z } from 'zod';

export const AMBIENCE_ASSET_STATUSES = Object.freeze(['active', 'inactive', 'archived']);
export const COMPANY_AMBIENCE_LIMIT = 20;

const name = z.string().trim().min(1, 'Ambience name is required').max(160);
const description = z.string().trim().max(1000).nullable();
const volume = z.number().int().min(0).max(100);

export const createAmbienceAssetSchema = z.object({
  name,
  description: description.default(null),
  status: z.enum(AMBIENCE_ASSET_STATUSES).default('active'),
  listeningVolumePercent: volume.default(10),
  speakingVolumePercent: volume.default(5),
  continueDuringSilence: z.boolean().default(true),
}).strict();

export const updateAmbienceAssetSchema = z.object({
  name,
  description,
  status: z.enum(AMBIENCE_ASSET_STATUSES),
  listeningVolumePercent: volume,
  speakingVolumePercent: volume,
  continueDuringSilence: z.boolean(),
}).partial().strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const ambienceAssetIdSchema = z.object({ assetId: z.string().uuid() }).strict();
export const replaceAgentAmbienceSchema = z.object({
  ambienceAssetId: z.string().uuid().nullable(),
}).strict();

export const listAmbienceAssetsSchema = z.object({
  search: z.string().trim().max(160).optional(),
  status: z.enum(AMBIENCE_ASSET_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export function parseAmbienceInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  };
}
