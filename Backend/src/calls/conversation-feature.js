import { env } from '../config/env.js';

export function isConversationContinuityEnabled(tenantId, configuration=env) {
  if(!configuration.VOICE_CONVERSATION_CONTINUITY_ENABLED)return false;
  const companies=configuration.VOICE_CONVERSATION_CONTINUITY_TENANT_IDS.split(',').map(id=>id.trim()).filter(Boolean);
  return companies.length===0 || companies.includes(tenantId);
}
