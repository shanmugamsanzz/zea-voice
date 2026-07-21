import { z } from 'zod';

const plivoPhoneSchema = z.string().trim()
  .regex(/^\+?[1-9][0-9]{6,14}$/)
  .transform((value) => (value.startsWith('+') ? value : `+${value}`));

export const plivoAnswerPayloadSchema = z.object({
  CallUUID: z.string().trim().min(1).max(240),
  From: plivoPhoneSchema,
  To: plivoPhoneSchema,
  Direction: z.enum(['inbound', 'outbound']).optional(),
  CallStatus: z.string().trim().max(80).optional(),
}).passthrough();
