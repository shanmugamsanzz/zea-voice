import { z } from 'zod';

export const callTransferSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  credentialSource: z.enum(['saved_account', 'manual']),
  telephonyAccountId: z.string().uuid().nullable().optional(),
  authId: z.string().trim().regex(/^SA[A-Z0-9]{8,78}$/, 'Enter a Plivo subaccount Auth ID').optional(),
  // Never return or put this value in agent settings/prompt/tool arguments.
  authToken: z.string().min(16).max(512).regex(/^\S+$/, 'Token must not contain whitespace').optional(),
  destinationNumber: z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, 'Use an E.164 number, for example +919876543210'),
  mode: z.enum(['direct_handoff', 'wait_and_return']),
  ringTimeoutSeconds: z.number().int().min(10).max(120),
  callbackToolId: z.string().uuid().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.credentialSource === 'saved_account') {
    if (!value.telephonyAccountId) ctx.addIssue({ code: 'custom', path: ['telephonyAccountId'], message: 'Select a company Plivo subaccount' });
    if (value.authId || value.authToken) ctx.addIssue({ code: 'custom', path: ['credentialSource'], message: 'Saved accounts must not include manual credentials' });
  } else {
    if (!value.authId) ctx.addIssue({ code: 'custom', path: ['authId'], message: 'Auth ID is required' });
    if (value.telephonyAccountId) ctx.addIssue({ code: 'custom', path: ['telephonyAccountId'], message: 'Do not select an account for manual credentials' });
  }
});
