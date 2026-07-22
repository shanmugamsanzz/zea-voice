import { z } from 'zod';

export const n8nTriggerCallSchema = z.object({
  organization_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  customer_number: z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Must be a valid E.164 phone number'),
}).strict();
