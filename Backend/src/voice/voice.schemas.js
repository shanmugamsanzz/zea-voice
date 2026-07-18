import { z } from 'zod';

const e164Schema = z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/);

export const plivoAnswerPayloadSchema = z.object({
  CallUUID: z.string().trim().min(1).max(240),
  From: e164Schema,
  To: e164Schema,
  Direction: z.enum(['inbound', 'outbound']).optional(),
  CallStatus: z.string().trim().max(80).optional(),
}).passthrough();
