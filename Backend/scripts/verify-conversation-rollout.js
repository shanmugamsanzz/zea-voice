import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isConversationContinuityEnabled } from '../src/calls/conversation-feature.js';
import { loadDynamicPromptValues } from '../src/voice/dynamic-prompt-values.js';
import { needsContextualOpening,buildContextualOpeningInstruction } from '../src/voice/conversation-opening.js';

const config={VOICE_CONVERSATION_CONTINUITY_ENABLED:false,VOICE_CONVERSATION_CONTINUITY_TENANT_IDS:''};
assert.equal(isConversationContinuityEnabled('a',config),false);
config.VOICE_CONVERSATION_CONTINUITY_ENABLED=true;config.VOICE_CONVERSATION_CONTINUITY_TENANT_IDS=' a, b ';
assert.equal(isConversationContinuityEnabled('a',config),true);
assert.equal(isConversationContinuityEnabled('other',config),false);
config.VOICE_CONVERSATION_CONTINUITY_TENANT_IDS='';assert.equal(isConversationContinuityEnabled('other',config),true);
config.VOICE_CONVERSATION_CONTINUITY_ENABLED=false;assert.equal(isConversationContinuityEnabled('a',config),false);

const call={id:'inbound-now',tenantId:'company',workspaceId:'workspace',direction:'inbound',fromNumber:'+919123456789'};
let historyChecked=false;
const values=await loadDynamicPromptValues(call,{previousSummaryCount:2},{contextRunner:operation=>operation({query:async(sql,args)=>{
  if(sql.startsWith('SET LOCAL'))return {};
  if(sql.includes('FROM call_sessions c'))return {rowCount:1,rows:[{direction:'inbound',from_number:call.fromNumber,contact_id:'contact',display_name:'Ravi',has_prior_conversation:true}]};
  if(sql.includes('FROM call_ai_summaries'))return {rows:[{summary_text:'Caller requested a callback to continue their inquiry.',outcome:'callback_requested'}]};
  assert.deepEqual(args,[call.id,call.tenantId,call.workspaceId,'contact']);
  assert.match(sql,/c.direction='inbound'/);assert.match(sql,/t.status IN \('no_answer','busy','failed'\)/);
  assert.match(sql,/t.workspace_id=\$3/);assert.match(sql,/t.finished_at>=now\(\)-interval '7 days'/);
  historyChecked=true;
  return {rows:[{purpose:'Continue the requested inquiry',status:'no_answer',current_attempt:false,scheduled_for:'2026-10-07T09:00:00Z'}]};
}})});
assert.equal(historyChecked,true);assert.equal(values['callback.status'],'no_answer');
assert.equal(values['call.purpose'],'unknown','An inbound call is not relabeled as the scheduled outbound attempt');
assert.equal(needsContextualOpening(values),true);
assert.match(buildContextualOpeningInstruction(values,'en'),/no_answer/);
assert.match(buildContextualOpeningInstruction(values,'en'),/phone match or stored name does not verify identity/);
const runtime=await readFile(new URL('../src/voice/realtime-conversation-orchestrator.js',import.meta.url),'utf8');
assert.match(runtime,/continuityEnabled && this.mediaSession.transport/);
assert.match(runtime,/!continuityEnabled \|\| this.mediaSession.transport/);
const dispatcher=await readFile(new URL('../src/calls/follow-up-dispatch.service.js',import.meta.url),'utf8');
assert.match(dispatcher,/deps.featureEnabled\?\?isConversationContinuityEnabled/);
console.log('PASS continuity rollout: off/on, company canary and rollback; missed callback followed by scoped inbound history, truthful purpose and contextual opening');
