import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
process.env.VOICE_CONVERSATION_CONTINUITY_ENABLED='true';
process.env.VOICE_CONVERSATION_CONTINUITY_TENANT_IDS='';
process.env.VOICE_COMPANY_QUEUE_ENABLED='true';
process.env.VOICE_COMPANY_QUEUE_TENANT_IDS='';
const {resolveLocalFollowUp,resolveRelativeFollowUp}=await import('../src/calls/follow-up-time.js');
const {manageLiveFollowUp,cancelFollowUp}=await import('../src/calls/follow-up.service.js');
const {enqueueDueFollowUps,bindFollowUpCall,finishValidatedFollowUp,recoverCampaignFollowUps}=await import('../src/calls/follow-up-dispatch.service.js');
const {manageFollowUpTool}=await import('../src/voice/tools/manage-follow-up.service.js');
const {executeAgentTool}=await import('../src/voice/tools/tool-executor.service.js');
const {up}=await import('../migrations/1791374000000_follow-up-dispatch.js');

assert.equal(resolveLocalFollowUp('2026-10-08','19:00','Asia/Kolkata').requestedFor,'2026-10-08T13:30:00.000Z');
assert.equal(resolveLocalFollowUp('2026-02-30','19:00','Asia/Kolkata').resolved,false);
assert.equal(resolveLocalFollowUp('2026-10-08','19:00','wrong/zone').reason,'invalid_timezone');
assert.equal(resolveLocalFollowUp('2026-11-01','01:30','America/New_York').reason,'ambiguous_dst_time');
assert.equal(resolveLocalFollowUp('2026-03-08','02:30','America/New_York').reason,'nonexistent_dst_time');
assert.equal(resolveRelativeFollowUp('Call me after ten minutes').delayMs,600000);
assert.equal(resolveRelativeFollowUp('Remind me in 5 minutes').delayMs,300000);
assert.equal(resolveRelativeFollowUp('Do not call me in 10 minutes').resolved,false);
assert.equal(resolveRelativeFollowUp('Call me after 7 oclock').resolved,false);

const profile={agent:{id:'agent',tenantId:'tenant',workspaceId:'workspace'},tools:[manageFollowUpTool]};
const call={id:'call',agentId:'agent',tenantId:'tenant',workspaceId:'workspace',direction:'inbound'};
const stored={id:'call',status:'connected',direction:'inbound',from_number:'+919123456789',to_number:'+918000000000',phone_e164:'+919123456789',
  tenant_id:'tenant',workspace_id:'workspace',agent_id:'agent',conversation_id:'thread',usage_direction:'both',timezone:'Asia/Kolkata',
  settings:{callbackEnabled:true},provider_metadata:{}};
const tasks=[];const queries=[];
const response=rows=>({rows,rowCount:rows.length});
const client={async query(sql,values=[]){
  queries.push({sql,values});
  if(sql.includes('FROM call_sessions c JOIN voice_agents'))return response([{...stored}]);
  if(sql.includes('FROM scheduled_follow_up_tasks WHERE tenant_id=$1 AND request_key'))return response(tasks.filter(task=>task.request_key===values[1]));
  if(sql.includes('SELECT id,purpose FROM scheduled_follow_up_tasks'))return response([]);
  if(sql.includes('SELECT max_outbound_queued_tasks'))return response([{max_outbound_queued_tasks:100}]);
  if(sql.includes('SELECT count(*)::int count'))return response([{count:tasks.length}]);
  if(sql.includes('INSERT INTO scheduled_follow_up_tasks')){
    const task={id:`task-${tasks.length+1}`,tenant_id:values[0],workspace_id:values[1],agent_id:values[2],conversation_id:values[3],request_key:values[5],
      kind:values[6],purpose:values[7],requested_for:values[8],status:'scheduled',campaign_task_id:values[11],campaign_origin_attempt_id:values[12]};tasks.push(task);return response([task]);
  }
  if(sql.includes("'{followUpProposal}'")){stored.provider_metadata.followUpProposal=JSON.parse(values[1]);return response([]);}
  if(sql.includes("provider_metadata-'followUpProposal'")){delete stored.provider_metadata.followUpProposal;return response([]);}
  if(sql.startsWith('SELECT * FROM scheduled_follow_up_tasks'))return response(tasks.filter(task=>task.id===values[0]&&task.tenant_id===values[1]));
  if(sql.startsWith('SELECT id FROM agent_phone_test_requests')||sql.startsWith('SELECT status FROM agent_phone_test_requests'))return response([]);
  if(sql.includes("SET status='canceled'")){const task=tasks.find(task=>task.id===values[0]);if(task)task.status='canceled';return response([]);}
  if(sql.includes("SET status='queued'")){const task=tasks.find(task=>task.id===values[0]);if(task)task.status='queued';return response([]);}
  if(sql.startsWith('SELECT id FROM scheduled_follow_up_tasks'))return response([]);
  if(sql.startsWith('INSERT INTO audit_logs')||sql.startsWith('SELECT tenant_id FROM tenant_limits'))return response([]);
  assert.fail(`Unexpected SQL: ${sql}`);
}};
const deps={authorized:true,contextRunner:operation=>operation(client)};
const request={currentUserMessage:'Call me in 10 minutes',arguments:{action:'schedule',evidence:'Call me in 10 minutes',purpose:'Continue this inquiry',kind:'callback'}};
await assert.rejects(manageLiveFollowUp(profile,call,request,{}),error=>error.statusCode===403);
const first=await manageLiveFollowUp(profile,call,request,deps);
assert.equal(first.scheduled,true);assert.equal(tasks.length,1);
const again=await manageLiveFollowUp(profile,call,request,deps);
assert.equal(again.idempotent,true);assert.equal(tasks.length,1);
const wrong=await manageLiveFollowUp(profile,call,{...request,currentUserMessage:'Do not call me in 10 minutes'},deps);
assert.equal(wrong.scheduled,false);assert.equal(tasks.length,1);
await assert.rejects(manageLiveFollowUp(profile,{...call,tenantId:'foreign'},request,deps),error=>error.statusCode===403);
stored.direction='outbound';stored.from_number='+918000000000';stored.to_number='+919123456789';
assert.equal((await manageLiveFollowUp(profile,{...call,direction:'outbound'},{currentUserMessage:'Remind me in 5 minutes',arguments:{action:'schedule',evidence:'Remind me in 5 minutes',purpose:'Requested reminder',kind:'reminder'}},deps)).scheduled,true);
stored.provider_metadata.source='browser_test';
await assert.rejects(manageLiveFollowUp(profile,call,request,deps),error=>error.code==='FOLLOW_UP_CALL_UNAVAILABLE');
delete stored.provider_metadata.source;
const future=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
const absolute={currentUserMessage:'Call me tomorrow at seven',arguments:{action:'schedule',evidence:'Call me tomorrow at seven',purpose:'Continue inquiry',localDate:future,localTime:'19:00',timeZone:'Asia/Kolkata'}};
const proposed=await manageLiveFollowUp(profile,call,absolute,deps);
assert.equal(proposed.reason,'confirm_absolute_time');assert.equal(tasks.length,2);
const confirm={currentUserMessage:'Yes',arguments:{action:'confirm',evidence:'Yes'},conversation:[{role:'assistant',content:`Confirm ${future} 19:00 Asia/Kolkata?`}]};
assert.equal((await manageLiveFollowUp(profile,call,{...confirm,conversation:[{role:'assistant',content:'Is your name correct?'}]},deps)).scheduled,false);
assert.equal((await manageLiveFollowUp(profile,call,confirm,deps)).scheduled,true);assert.equal(tasks.length,3);
assert.equal((await manageLiveFollowUp(profile,call,confirm,deps)).idempotent,true);assert.equal(tasks.length,3);
assert.equal((await cancelFollowUp(client,{tenantId:'tenant',workspaceId:'workspace',conversationId:'thread'},tasks[0].id)).canceled,true);
assert.equal((await cancelFollowUp(client,{tenantId:'tenant',workspaceId:'workspace',conversationId:'thread'},tasks[0].id)).unchanged,true);
tasks[1].status='initiated';
assert.equal((await cancelFollowUp(client,{tenantId:'tenant',workspaceId:'workspace',conversationId:'thread'},tasks[1].id)).canceled,false);
await assert.rejects(cancelFollowUp(client,{tenantId:'foreign',workspaceId:'workspace',conversationId:'thread'},tasks[0].id),error=>error.statusCode===404);
await assert.rejects(executeAgentTool(profile,call,{name:'manage_follow_up',arguments:request.arguments},{requireWorkflowAuthorization:true}),error=>error.code==='VOICE_TOOL_WORKFLOW_AUTHORIZATION_REQUIRED');

stored.campaign_task_id='campaign-task';stored.campaign_attempt_id='original-attempt';
const campaignRequest={currentUserMessage:'Call me in 15 minutes',arguments:{action:'schedule',evidence:'Call me in 15 minutes',purpose:'Campaign callback'}};
const beforeCampaign=tasks.length;
const denied=await manageLiveFollowUp(profile,call,campaignRequest,{...deps,scheduleCampaign:async()=>({scheduled:false,reason:'retry_limit_reached'})});
assert.equal(denied.reason,'retry_limit_reached');assert.equal(tasks.length,beforeCampaign);
let reusedTransaction=false;
const mirrored=await manageLiveFollowUp(profile,call,campaignRequest,{...deps,scheduleCampaign:async(input,options)=>{
  await options.contextRunner(async supplied=>{reusedTransaction=supplied===client;});
  return {scheduled:true,requestedFor:input.requestedFor};
}});
assert.equal(mirrored.scheduled,true);assert.equal(mirrored.status,'queued');assert.equal(reusedTransaction,true);
assert.equal(tasks.at(-1).campaign_task_id,'campaign-task');assert.equal(tasks.at(-1).campaign_origin_attempt_id,'original-attempt');
assert.equal((await manageLiveFollowUp(profile,call,campaignRequest,{...deps,scheduleCampaign:()=>assert.fail('Duplicate callback must not consume another retry')})).idempotent,true);
delete stored.campaign_task_id;delete stored.campaign_attempt_id;
const tamilRequest={currentUserMessage:'இல்லை ஒரு 2 minutes கழிச்சு call பண்ணு',arguments:{action:'schedule',evidence:'இல்லை ஒரு 2 minutes கழிச்சு call பண்ணு',
  purpose:'Continue the current conversation',kind:'callback',delayMinutes:2,callerConfirmed:true}};
const beforeRelative=tasks.length;
const relativeStarted=Date.now();
const tamilScheduled=await manageLiveFollowUp(profile,call,tamilRequest,deps);
assert.equal(tamilScheduled.scheduled,true);assert.equal(tasks.length,beforeRelative+1);
assert.ok(Math.abs(new Date(tamilScheduled.requestedFor).getTime()-relativeStarted-120000)<2000);
assert.equal((await manageLiveFollowUp(profile,call,tamilRequest,deps)).idempotent,true);
const { evidence: omittedEvidence, ...withoutEvidence } = tamilRequest.arguments;
assert.equal((await manageLiveFollowUp(profile,call,{...tamilRequest,arguments:withoutEvidence},deps)).idempotent,true);
assert.equal((await manageLiveFollowUp(profile,call,{...tamilRequest,arguments:{...withoutEvidence,evidence:'A paraphrase, not a transcript quote'}},deps)).idempotent,true);
assert.equal(tasks.length,beforeRelative+1);
assert.equal((await manageLiveFollowUp(profile,call,{...tamilRequest,currentUserMessage:''},deps)).scheduled,false);
assert.equal((await manageLiveFollowUp(profile,call,{...tamilRequest,arguments:{...tamilRequest.arguments,callerConfirmed:false}},deps)).scheduled,false);
assert.equal((await manageLiveFollowUp(profile,call,{...tamilRequest,arguments:{...tamilRequest.arguments,delayMinutes:NaN}},deps)).scheduled,false);

let transfer=0;
const transferDeps={queueEnabled:()=>true,contextRunner:async operation=>operation({query:async(sql,values)=>{
  if(sql.startsWith('UPDATE scheduled_follow_up_tasks t'))return response([]);
  if(sql.startsWith('SELECT id,tenant_id'))return response([{id:'due',tenant_id:'tenant'}]);
  if(sql.includes('SELECT t.*,ct.phone_e164'))return transfer?response([]):response([{id:'due',tenant_id:'tenant',workspace_id:'workspace',agent_id:'agent',phone_e164:'+919123456789'}]);
  if(sql.startsWith('INSERT INTO agent_phone_test_requests')){assert.equal(values[4],'due');transfer++;return response([]);}
  return response([]);
}})};
assert.equal(await enqueueDueFollowUps(transferDeps),1);assert.equal(await enqueueDueFollowUps(transferDeps),0);assert.equal(transfer,1);
let bound=[];
assert.equal(await bindFollowUpCall('reservation',{...call,direction:'outbound',to:'+919123456789'}, {contextRunner:async operation=>operation({query:async(sql,values)=>{
  bound.push({sql,values});return sql.startsWith('SELECT t.*')?response([{id:'due',tenant_id:'tenant',workspace_id:'workspace',phone:'+919123456789',purpose:'Requested callback'}]):response([]);
}})}),true);
assert.ok(bound.some(entry=>entry.sql.includes('INSERT INTO follow_up_call_attempts')));
assert.ok(bound.some(entry=>entry.sql.includes('UPDATE conversation_call_links')));
let outcomeWrites=0;
await finishValidatedFollowUp('reservation',{capacityTenantId:'tenant',direction:'outbound',to:'+919123456789'},{HangupCauseName:'USER_BUSY'}, {contextRunner:async operation=>operation({query:async(sql,values)=>{
  if(sql.startsWith('SELECT t.*'))return response([{id:'due',phone:'+919123456789'}]);
  if(sql.startsWith('SELECT id FROM follow_up_call_attempts'))return response([{id:'attempt'}]);
  assert.equal(values[1],'busy');outcomeWrites++;return response([]);
}})});
assert.equal(outcomeWrites,1);
const recoveredJobs=[];
const recoveryDeps={queueEnabled:()=>true,contextRunner:operation=>operation({query:async()=>response([{id:'campaign-task',tenant_id:'tenant',workspace_id:'workspace',campaign_id:'campaign',retry_count:1}])}),
  queue:{add:async(name,data,options)=>recoveredJobs.push({name,data,options})}};
assert.equal(await recoverCampaignFollowUps(recoveryDeps),1);
assert.equal(await recoverCampaignFollowUps(recoveryDeps),1);
assert.equal(recoveredJobs[0].options.jobId,recoveredJobs[1].options.jobId);
assert.equal(recoveredJobs[0].data.taskId,'campaign-task');
assert.equal(await recoverCampaignFollowUps({...recoveryDeps,featureEnabled:()=>false}),0);
assert.equal(await enqueueDueFollowUps({...transferDeps,featureEnabled:()=>false}),0);
assert.equal(recoveredJobs.length,2,'Rollback must stop new campaign queue recovery');
const migration=[];await up({sql:value=>migration.push(value)});
const sql=migration.join('\n');
for(const required of ['follow_up_active_time_unique','phone_queue_follow_up_scope','ON CONFLICT(call_session_id) DO NOTHING','campaign_follow_up_status'])assert.ok(sql.includes(required));
assert.doesNotMatch(sql,/DELETE FROM call_transcript_entries|UPDATE campaign_tasks SET retry_count/);
console.log('PASS follow-ups: relative/absolute times, DST, consent/confirmation, both directions, browser/company isolation, request idempotency, cancellation, atomic due transfer, call linking and busy outcome fixtures');
