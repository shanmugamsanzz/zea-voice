import assert from 'node:assert/strict';
import { up, down } from '../migrations/1791373000000_conversation-summary-context.js';
import { claimPostCallSummaryJob, completePostCallSummaryJob, failPostCallSummaryJob } from '../src/voice/postcall-summary/postcall-summary-job.service.js';
import { executePostCallSummaryJob } from '../src/voice/postcall-summary/postcall-summary.processor.js';
import { buildPostCallSummaryMessages } from '../src/voice/postcall-summary/postcall-summary-output.js';
import { buildDynamicPromptValues } from '../src/voice/dynamic-prompt-values.js';

const statements=[];
await up({sql:value=>statements.push(value)});
const sql=statements.join('\n');
assert.match(sql,/ADD COLUMN processing_token uuid/);
assert.match(sql,/l.call_session_id=NEW.call_session_id AND l.tenant_id=NEW.tenant_id/);
assert.match(sql,/cv.id=l.conversation_id AND cv.tenant_id=l.tenant_id/);
assert.match(sql,/OLD.status IS DISTINCT FROM NEW.status/);
assert.doesNotMatch(sql,/DELETE|TRUNCATE|UPDATE call_transcript_entries|UPDATE call_sessions/);
const rollback=[];
await down({sql:value=>rollback.push(value)});
assert.doesNotMatch(rollback.join('\n'),/DROP TABLE|DELETE/);
const messages=buildPostCallSummaryMessages({instructions:'Capture inquiry',transcript:[]});
for(const key of ['call_purpose','information_collected','information_missing','pending_questions','current_status','next_action','requested_time_text'])assert.ok(messages[0].content.includes(key));

const active={id:'job',status:'processing',attempt_count:1,max_attempts:3,processing_started_at:new Date(),processing_token:'current'};
const held=await claimPostCallSummaryJob('job',{contextRunner:async(_actor,operation)=>operation({query:async text=>{
  assert.match(text,/FOR UPDATE/);
  return {rowCount:1,rows:[active]};
}})});
assert.equal(held.claimed,false);
assert.equal(held.reason,'already_processing');
const exhausted=await claimPostCallSummaryJob('job',{contextRunner:async(_actor,operation)=>operation({query:async text=>{
  if(text.startsWith('SELECT'))return {rowCount:1,rows:[{...active,processing_started_at:new Date(0),attempt_count:3}]};
  assert.match(text,/POSTCALL_SUMMARY_ATTEMPTS_EXHAUSTED/);
  return {rowCount:1,rows:[{...active,status:'failed'}]};
}})});
assert.equal(exhausted.reason,'attempts_exhausted');
assert.equal(exhausted.job.status,'failed');

let writes=0;
await assert.rejects(completePostCallSummaryJob('job',{summary:'stale'}, {
  processingToken:'old',contextRunner:async(_actor,operation)=>operation({query:async(text,values)=>{
    writes++;
    assert.match(text,/processing_token=\$12::uuid/);
    assert.equal(values[11],'old');
    return {rowCount:0,rows:[]};
  }}),
}),error=>error.code==='POSTCALL_SUMMARY_NOT_PROCESSING');
assert.equal(writes,1,'Stale completion must not insert usage or billing');
await assert.rejects(failPostCallSummaryJob('job',new Error('late'),{}, {
  processingToken:'old',contextRunner:async(_actor,operation)=>operation({query:async(text,values)=>{
    if(text.startsWith('SELECT'))return {rowCount:1,rows:[active]};
    assert.match(text,/processing_token=\$5::uuid/);
    assert.equal(values[4],'old');
    return {rowCount:0,rows:[]};
  }}),
}),error=>error.code==='POSTCALL_SUMMARY_NOT_PROCESSING');

const transcript=[{role:'user',content:'Call me in ten minutes.'}];
const original=structuredClone(transcript);
const stale=await executePostCallSummaryJob('job',{}, {
  claim:async()=>({claimed:true,job:{id:'job',processingToken:'old',transcript,provider:{}}}),
  adapter:{async *stream(){yield {type:'text_delta',delta:'{"summary":"Requested callback."}'};}},
  complete:async(_id,_result,dependencies)=>{
    assert.equal(dependencies.processingToken,'old');
    throw Object.assign(new Error('Claim replaced'),{code:'POSTCALL_SUMMARY_NOT_PROCESSING'});
  },
  fail:async()=>assert.fail('Stale completion must not fail the newer job'),
  deliverWebhook:async()=>assert.fail('Stale completion must not deliver a webhook'),
});
assert.equal(stale.reason,'claim_lost');
assert.deepEqual(transcript,original);
const context=buildDynamicPromptValues({summaries:[{summary_text:'Callback requested; details missing.',outcome:'callback_requested',collected_data:{pending_questions:['Preferred appointment time?']}}]});
assert.equal(context['conversation.last_outcome'],'callback_requested');
assert.equal(context['conversation.pending_questions'],'Preferred appointment time?');
console.log('PASS summary continuity: structure, context, scoped trigger, live-claim exclusion, stale retry fencing, no duplicate billing/webhook and transcript preservation fixtures');
console.log('Live PostgreSQL/Redis restart and concurrent worker checks remain required in staging.');
