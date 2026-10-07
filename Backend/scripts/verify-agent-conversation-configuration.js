import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { createAgentSchema, updateAgentSchema } = await import('../src/agents/agent.schemas.js');
const { agentConversationConfiguration, saveAgentConversationConfiguration } = await import('../src/agents/agent-conversation-configuration.js');
const { env } = await import('../src/config/env.js');
const legacy = { prompt: 'Legacy prompt', welcome_message: 'Legacy welcome' };
assert.deepEqual(agentConversationConfiguration({},legacy), {
  inboundPrompt: 'Legacy prompt', outboundPrompt: 'Legacy prompt',
  inboundWelcomeMessage: 'Legacy welcome', outboundWelcomeMessage: 'Legacy welcome',
  previousSummaryCount: 2, previousSummaryMaxChars: 6000,
});
const stored = { ...legacy, inbound_prompt: 'Incoming', outbound_prompt: 'Outgoing',
  inbound_welcome_message: 'Hello', outbound_welcome_message: 'Calling about your request',
  previous_summary_count: 3, previous_summary_max_chars: 4000 };
const updated = agentConversationConfiguration({outboundPrompt:'New outbound',inboundWelcomeMessage:null,previousSummaryCount:0},stored);
assert.equal(updated.inboundPrompt,'Incoming');
assert.equal(updated.outboundPrompt,'New outbound');
assert.equal(updated.inboundWelcomeMessage,null);
assert.equal(updated.outboundWelcomeMessage,stored.outbound_welcome_message);
assert.equal(updated.previousSummaryCount,0);
assert.equal(updated.previousSummaryMaxChars,4000);
for (const input of [{inboundPrompt:''},{outboundPrompt:'x'.repeat(env.LLM_SYSTEM_PROMPT_MAX_CHARS+1)},
  {previousSummaryCount:-1},{previousSummaryCount:11},{previousSummaryCount:1.5},
  {previousSummaryMaxChars:499},{previousSummaryMaxChars:20001},{inboundWelcomeMessage:'x'.repeat(10001)}]) {
  assert.equal(updateAgentSchema.safeParse(input).success,false);
}
assert.equal(updateAgentSchema.safeParse({previousSummaryCount:0,previousSummaryMaxChars:500,outboundWelcomeMessage:null}).success,true);
const id = '10000000-0000-4000-8000-000000000001';
assert.equal(createAgentSchema.safeParse({name:'Legacy',voiceId:'voice',prompt:'Existing',sttModelId:id,llmModelId:id,ttsModelId:id}).success,true);
let saved;
await saveAgentConversationConfiguration({query:async(sql,values)=> {
  assert.match(sql,/WHERE tenant_id=\$1 AND id=\$2/);
  assert.equal(values.length,8);
  saved=values;
}},'company','agent',{outboundPrompt:'New outbound',inboundWelcomeMessage:null,previousSummaryCount:0},stored);
assert.deepEqual(saved,['company','agent','Incoming','New outbound',null,'Calling about your request',0,4000]);
console.log('PASS agent conversation configuration: legacy compatibility, independent fields, clearing, PATCH preservation, bounds and scoped persistence');
