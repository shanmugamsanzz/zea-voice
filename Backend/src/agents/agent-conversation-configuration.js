// Explicit direction fields win. Omitted PATCH fields retain their stored values.
// Legacy clients can still update the original prompt without modifying runtime routing.
export function agentConversationConfiguration(input, before = {}) {
  const prompt = input.prompt ?? before.prompt;
  const welcome = Object.hasOwn(input, 'welcomeMessage') ? input.welcomeMessage : before.welcome_message ?? null;
  return {
    inboundPrompt: input.inboundPrompt ?? before.inbound_prompt ?? prompt,
    outboundPrompt: input.outboundPrompt ?? before.outbound_prompt ?? prompt,
    inboundWelcomeMessage: Object.hasOwn(input, 'inboundWelcomeMessage') ? input.inboundWelcomeMessage
      : Object.hasOwn(before, 'inbound_welcome_message') ? before.inbound_welcome_message : welcome,
    outboundWelcomeMessage: Object.hasOwn(input, 'outboundWelcomeMessage') ? input.outboundWelcomeMessage
      : Object.hasOwn(before, 'outbound_welcome_message') ? before.outbound_welcome_message : welcome,
    previousSummaryCount: input.previousSummaryCount ?? before.previous_summary_count ?? 2,
    previousSummaryMaxChars: input.previousSummaryMaxChars ?? before.previous_summary_max_chars ?? 6000,
  };
}

export async function saveAgentConversationConfiguration(client, tenantId, agentId, input, before) {
  const value = agentConversationConfiguration(input, before);
  await client.query(`UPDATE voice_agents SET inbound_prompt=$3,outbound_prompt=$4,
    inbound_welcome_message=$5,outbound_welcome_message=$6,
    previous_summary_count=$7,previous_summary_max_chars=$8 WHERE tenant_id=$1 AND id=$2`,
  [tenantId,agentId,value.inboundPrompt,value.outboundPrompt,value.inboundWelcomeMessage,
    value.outboundWelcomeMessage,value.previousSummaryCount,value.previousSummaryMaxChars]);
}
