import { z } from 'zod';

const plivoMainAuthId = z.string().trim().min(5).max(240).regex(
  /^MA[A-Za-z0-9]+$/,
  'Use the Plivo Account Auth ID beginning with MA, not a SIP URI',
);

export const createTelephonyAccountSchema = z.object({
  name: z.string().trim().min(1).max(160),
  provider: z.literal('plivo').default('plivo'),
  authId: plivoMainAuthId,
  authToken: z.string().min(8).max(1000),
  baseUrl: z.string().trim().url().max(1000),
  applicationId: z.string().trim().max(240).default(''),
  answerUrl: z.string().trim().url().max(1000),
  hangupUrl: z.string().trim().url().max(1000),
  recordingCallbackUrl: z.string().trim().url().max(1000),
  status: z.enum(['connected', 'disconnected']).default('connected'),
});

export const updateTelephonyAccountSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  authId: plivoMainAuthId.optional(),
  authToken: z.string().min(8).max(1000).optional(),
  baseUrl: z.string().trim().url().max(1000).optional(),
  applicationId: z.string().trim().min(1).max(240).optional(),
  answerUrl: z.string().trim().url().max(1000).optional(),
  hangupUrl: z.string().trim().url().max(1000).optional(),
  recordingCallbackUrl: z.string().trim().url().max(1000).optional(),
  status: z.enum(['connected', 'disconnected', 'error']).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const accountIdSchema = z.object({ accountId: z.string().uuid() });
export const phoneNumberIdSchema = z.object({ phoneNumberId: z.string().uuid() });
export const assignPhoneNumberSchema = z.object({ companyId: z.string().uuid() });
export const releasePhoneNumberSchema = z.object({ reason: z.string().trim().max(300).optional() });
export const listPhoneNumbersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  assignment: z.enum(['all', 'assigned', 'unassigned']).default('all'),
  companyId: z.string().uuid().optional(),
  status: z.enum(['active', 'unavailable', 'released']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseTelephonyInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
