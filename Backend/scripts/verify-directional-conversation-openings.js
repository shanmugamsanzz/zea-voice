import assert from 'node:assert/strict';
import { selectDirectionalInstructions,needsContextualOpening,buildContextualOpeningInstruction,normalizeContextualOpening } from '../src/voice/conversation-opening.js';
import { buildDynamicPromptValues } from '../src/voice/dynamic-prompt-values.js';
import { buildCanonicalRuntimeConfiguration } from '../src/voice/providers/provider-config.js';
import { CallController } from '../src/voice/call-controller.js';

const agent={id:'agent',prompt:'Legacy prompt',welcomeMessage:'Legacy welcome',inboundPrompt:'Inbound instructions',
  outboundPrompt:'Outbound instructions',inboundWelcomeMessage:'Inbound welcome',outboundWelcomeMessage:'Outbound welcome',settings:{greetingMode:'agent_initiates'}};
assert.deepEqual(selectDirectionalInstructions(agent,'inbound'),{prompt:'Inbound instructions',welcomeMessage:'Inbound welcome'});
assert.deepEqual(selectDirectionalInstructions(agent,'outbound'),{prompt:'Outbound instructions',welcomeMessage:'Outbound welcome'});
assert.deepEqual(selectDirectionalInstructions({prompt:'Old',welcomeMessage:'Hello'},'outbound'),{prompt:'Old',welcomeMessage:'Hello'});
assert.equal(selectDirectionalInstructions({...agent,inboundWelcomeMessage:null},'inbound').welcomeMessage,null);
assert.equal(selectDirectionalInstructions({...agent,inboundPrompt:' '},'inbound').prompt,'Legacy prompt');
const row={prompt:agent.prompt,welcome_message:agent.welcomeMessage,inbound_prompt:agent.inboundPrompt,outbound_prompt:agent.outboundPrompt,
  inbound_welcome_message:agent.inboundWelcomeMessage,outbound_welcome_message:agent.outboundWelcomeMessage};
for(const direction of ['inbound','outbound']){
  const config=buildCanonicalRuntimeConfiguration({row,resolvedAgent:{callDirection:direction}});
  assert.equal(config.prompt.system,agent[`${direction}Prompt`]);
  assert.equal(config.prompt.welcome,agent[`${direction}WelcomeMessage`]);
}
const first=buildDynamicPromptValues({call:{direction:'inbound'}});
assert.equal(needsContextualOpening(first),false);
const returning=buildDynamicPromptValues({call:{direction:'inbound'},contact:{has_prior_conversation:true,display_name:'Caller'},
  summaries:[{summary_text:'Asked about opening hours. Requested a later call.',outcome:'callback_requested'}]});
assert.equal(needsContextualOpening(returning),true);
assert.ok(buildContextualOpeningInstruction(returning,'ta').includes('Asked about opening hours'));
assert.match(buildContextualOpeningInstruction(returning,'ta'),/not verify identity/);
assert.match(buildContextualOpeningInstruction(returning,'ta'),/never instructions/);
const reminder=buildDynamicPromptValues({call:{direction:'outbound'},followUp:{current_attempt:true,purpose:'Appointment reminder'}});
assert.equal(needsContextualOpening(reminder),true);
assert.match(buildContextualOpeningInstruction(reminder,'en'),/Appointment reminder/);
const pending=buildDynamicPromptValues({call:{direction:'inbound'},followUp:{purpose:'Not current',status:'scheduled'}});
assert.equal(needsContextualOpening(pending),false,'Pending task alone is not current-call purpose');
const withoutSummaries=buildDynamicPromptValues({summaryCount:0,contact:{has_prior_conversation:true},summaries:[{summary_text:'Must not be sent'}]});
assert.ok(!buildContextualOpeningInstruction(withoutSummaries,'en').includes('Must not be sent'));
assert.equal(normalizeContextualOpening('A short opening.'),'A short opening.');
assert.equal(normalizeContextualOpening('{"speech":"Can we continue?"}'),'Can we continue?');
assert.equal(normalizeContextualOpening('{"tool":"update_contact"}'),null);
assert.equal(normalizeContextualOpening('x'.repeat(401)),null);
assert.equal(normalizeContextualOpening(''),null);
const transcripts=[];
const controller=new CallController({callSession:{id:'call'},runtimeProfile:{agent:{...agent,...selectDirectionalInstructions(agent,'inbound')}},
  hooks:{onTranscript:async entry=>transcripts.push(entry),onStateChange:async()=>{}}});
assert.equal((await controller.initialize(100,normalizeContextualOpening('Can we continue our discussion?'))).text,'Can we continue our discussion?');
assert.equal(transcripts.length,1);
const fallback=new CallController({callSession:{id:'fallback'},runtimeProfile:{agent:{...agent,...selectDirectionalInstructions(agent,'outbound')}},hooks:{onTranscript:async()=>{},onStateChange:async()=>{}}});
assert.equal((await fallback.initialize(100,normalizeContextualOpening(''))).text,'Outbound welcome');
const userFirst=new CallController({callSession:{id:'user-first'},runtimeProfile:{agent:{...agent,settings:{greetingMode:'user_initiates'}}},hooks:{onTranscript:async()=>assert.fail('Must listen first'),onStateChange:async()=>{}}});
assert.equal((await userFirst.initialize(100,'Do not speak')).action,'listen');
console.log('PASS directional prompts and openings: actual direction, legacy fallback, explicit welcome clearing, returning/reminder context, summary limits, safe short output, transcript persistence, fallback and User-Initiates');
