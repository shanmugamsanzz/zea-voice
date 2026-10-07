import { createHash } from 'node:crypto';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { isCompanyCallQueueEnabled } from '../queues/company-queue-feature.js';
import { assertOutboundQueueSpace } from '../queues/outbound-queue-capacity.service.js';
import { resolveCallbackConfiguration } from '../voice/interaction/callback-config.js';
import { scheduleCustomerCallback } from '../campaigns/customer-callback.service.js';
import { resolveRelativeFollowUp,resolveLocalFollowUp } from './follow-up-time.js';
import { isConversationContinuityEnabled } from './conversation-feature.js';

const clean=value=>String(value??'').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim();
const clarification=(reason,instruction)=>({scheduled:false,clarificationRequired:true,reason,instruction});
const runner=deps=>deps.contextRunner??(operation=>withPlatformAdminContext(null,operation));
function requestKey(callId,evidence,kind) {
  const hex=createHash('sha256').update(`${callId}:${kind}:${clean(evidence)}`).digest('hex').slice(0,32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function cancelFollowUp(client,scope,id) {
  await client.query('SELECT tenant_id FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE',[scope.tenantId]);
  const selected=await client.query(`SELECT * FROM scheduled_follow_up_tasks
    WHERE id=$1 AND tenant_id=$2 AND ($3::uuid IS NULL OR workspace_id=$3) AND conversation_id=$4`,
    [id,scope.tenantId,scope.workspaceId,scope.conversationId]);
  if(!selected.rowCount)throw new AppError(404,'Follow-up was not found','FOLLOW_UP_NOT_FOUND');
  let task=selected.rows[0];
  // Match dispatcher/trigger lock order: queue record before follow-up task.
  if(task.campaign_task_id)await client.query('SELECT id FROM campaign_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[task.campaign_task_id,task.tenant_id]);
  else await client.query('SELECT id FROM agent_phone_test_requests WHERE follow_up_task_id=$1 FOR UPDATE',[id]);
  task=(await client.query('SELECT * FROM scheduled_follow_up_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id,scope.tenantId])).rows[0];
  if(task.status==='canceled')return {canceled:true,id,unchanged:true};
  if(!['scheduled','queued'].includes(task.status))return {canceled:false,reason:'already_started_or_finished'};
  if(task.campaign_task_id){
    const stopped=await client.query(`UPDATE campaign_tasks SET status='canceled',final_outcome='canceled',completed_at=now(),
      callback_scheduled_for=NULL WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND status='queued'
      AND callback_origin_attempt_id=$4 RETURNING id`,[task.campaign_task_id,task.tenant_id,task.workspace_id,task.campaign_origin_attempt_id]);
    if(!stopped.rowCount)return {canceled:false,reason:'already_started_or_changed'};
  } else {
    const request=await client.query('SELECT status FROM agent_phone_test_requests WHERE follow_up_task_id=$1 FOR UPDATE',[id]);
    if(request.rowCount && request.rows[0].status!=='queued')return {canceled:false,reason:'already_started_or_finished'};
    await client.query("UPDATE agent_phone_test_requests SET status='canceled',updated_at=now() WHERE follow_up_task_id=$1 AND status='queued'",[id]);
  }
  await client.query("UPDATE scheduled_follow_up_tasks SET status='canceled',canceled_at=now(),finished_at=now() WHERE id=$1 AND tenant_id=$2",[id,scope.tenantId]);
  await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,after_data)
    VALUES($1,$2,$3,$4,'FOLLOW_UP_CANCELED','scheduled_follow_up_task',$5,'{"status":"canceled"}'::jsonb)`,
    [task.tenant_id,task.workspace_id,scope.userId??null,scope.userId?'user':'system',id]);
  return {canceled:true,id};
}

export async function manageLiveFollowUp(profile,call,toolCall,deps={}) {
  if(!deps.authorized)throw new AppError(403,'Follow-up action requires workflow authorization','FOLLOW_UP_NOT_AUTHORIZED');
  const args=toolCall.arguments??{},evidence=clean(args.evidence),current=clean(toolCall.currentUserMessage);
  if(!evidence || !current.includes(evidence))return clarification('caller_evidence_required','Ask the caller to explicitly request or confirm this follow-up.');
  if(args.action!=='cancel' && /(?:don't|do not|never).*call|cancel|(?:he|she|they) (?:said|asked|wants)|my (?:wife|husband|mother|father|friend) (?:said|asked|wants)|on behalf|call (?:him|her|them)|அவருக்கு|அவங்களுக்கு|வேண்டாம்|ரத்து/iu.test(current))
    return clarification('explicit_own_request_required','Clarify whether the current caller personally wants this follow-up on their own number.');
  const scope=profile.agent;
  if(call.tenantId!==scope.tenantId || call.workspaceId!==scope.workspaceId || call.agentId!==scope.id)throw new AppError(403,'Call scope mismatch','FOLLOW_UP_SCOPE_MISMATCH');
  if(args.action!=='cancel' && !isConversationContinuityEnabled(scope.tenantId))return {scheduled:false,reason:'conversation_continuity_disabled'};
  if(!isCompanyCallQueueEnabled(scope.tenantId))return {scheduled:false,reason:'company_queue_disabled',instruction:'Do not promise a follow-up: company queue scheduling is not enabled.'};
  const result=await runner(deps)(async client=>{
    const selected=await client.query(`SELECT c.*,l.conversation_id,ct.phone_e164,a.settings,a.usage_direction,w.timezone,
      (SELECT ca.task_id FROM campaign_task_attempts ca WHERE ca.call_session_id=c.id AND ca.tenant_id=c.tenant_id LIMIT 1) AS campaign_task_id,
      (SELECT ca.id FROM campaign_task_attempts ca WHERE ca.call_session_id=c.id AND ca.tenant_id=c.tenant_id LIMIT 1) AS campaign_attempt_id
      FROM call_sessions c JOIN voice_agents a ON a.id=c.agent_id AND a.tenant_id=c.tenant_id AND a.workspace_id=c.workspace_id
      JOIN workspaces w ON w.id=c.workspace_id AND w.tenant_id=c.tenant_id
      JOIN conversation_call_links l ON l.call_session_id=c.id AND l.tenant_id=c.tenant_id
      JOIN contact_conversations cv ON cv.id=l.conversation_id AND cv.tenant_id=l.tenant_id
      JOIN conversation_contacts ct ON ct.id=cv.contact_id AND ct.tenant_id=cv.tenant_id
      WHERE c.id=$1 AND c.tenant_id=$2 AND c.workspace_id=$3 AND c.agent_id=$4 FOR UPDATE OF c`,
      [call.id,scope.tenantId,scope.workspaceId,scope.id]);
    const stored=selected.rows[0];
    if(!stored || !['ringing','connected'].includes(stored.status) || stored.provider_metadata?.source==='browser_test')throw new AppError(409,'A live phone conversation is required','FOLLOW_UP_CALL_UNAVAILABLE');
    if(stored.phone_e164!==(stored.direction==='inbound'?stored.from_number:stored.to_number))throw new AppError(409,'Contact does not match the current call','FOLLOW_UP_CONTACT_MISMATCH');
    if(args.action==='cancel') {
      if(!/(?:cancel|do not call|don't call|ரத்து|வேண்டாம்)/iu.test(evidence) || /(?:don't|do not|never) cancel/iu.test(current))return clarification('cancel_confirmation_required','Ask which follow-up the caller wants to cancel.');
      const pending=await client.query(`SELECT id,purpose,scheduled_for FROM scheduled_follow_up_tasks
        WHERE tenant_id=$1 AND workspace_id=$2 AND conversation_id=$3 AND status IN ('scheduled','queued')
        ORDER BY scheduled_for,id LIMIT 10`,[scope.tenantId,scope.workspaceId,stored.conversation_id]);
      const target=args.taskId??(pending.rows.length===1?pending.rows[0].id:null);
      if(!target)return {...clarification('select_follow_up','Ask which pending follow-up should be canceled.'),pending:pending.rows};
      return cancelFollowUp(client,{...scope,conversationId:stored.conversation_id},target);
    }
    const config=resolveCallbackConfiguration(stored.settings??{});
    if(!config.enabled)return {scheduled:false,reason:'follow_ups_disabled'};
    if(!['both','outbound'].includes(stored.usage_direction))return {scheduled:false,reason:'agent_outbound_not_enabled',instruction:'Do not promise a callback. This agent needs outbound calling enabled.'};
    let proposal;
    if(args.action==='confirm'){
      proposal=stored.provider_metadata?.followUpProposal;
      const previous=[...(toolCall.conversation??[])].reverse().find(entry=>entry.role==='assistant')?.content??'';
      if(!proposal || Date.now()-new Date(proposal.createdAt).getTime()>900000
        || !/^(?:yes|yes please|yes that is correct|confirm|correct|ஆம்|சரி)[.!]*$/iu.test(current)
        || ![proposal.localDate,proposal.localTime,proposal.timeZone].every(value=>clean(previous).includes(value))) {
        return clarification('explicit_confirmation_required','Repeat the exact proposed date, time and timezone and ask for confirmation.');
      }
    }else{
      if(!/(?:call\s+(?:me|back)|callback|remind\s+me|கால்|கூப்பிட|அழை|நினைவூட்டு|call pannu|koopidu)/iu.test(evidence)
        || /(?:don't|do not|never).*call|cancel|வேண்டாம்|ரத்து/iu.test(evidence))return clarification('explicit_request_required','Ask whether the caller wants a callback or reminder.');
      const relative=resolveRelativeFollowUp(evidence,{...config});
      const kind=args.kind??'callback',purpose=clean(args.purpose);
      if(!purpose)return clarification('purpose_required','Ask the purpose of the follow-up.');
      if(relative.resolved)proposal={kind,purpose,requestedFor:relative.requestedFor,timeZone:stored.timezone??'UTC',evidence};
      else{
        if(!args.timeZone)return clarification('timezone_required','Clarify the date, AM/PM and timezone, then propose an exact time.');
        const absolute=resolveLocalFollowUp(args.localDate,args.localTime,args.timeZone);
        if(!absolute.resolved)return clarification(absolute.reason,'Clarify an exact valid date, time and IANA timezone; ambiguous daylight-saving times need a different unambiguous time.');
        proposal={kind,purpose,...absolute,evidence,localDate:args.localDate,localTime:args.localTime,createdAt:new Date().toISOString()};
        await client.query(`UPDATE call_sessions SET provider_metadata=jsonb_set(COALESCE(provider_metadata,'{}'::jsonb),'{followUpProposal}',$2::jsonb,true) WHERE id=$1`,[call.id,JSON.stringify(proposal)]);
        return {...clarification('confirm_absolute_time',`Ask the caller to confirm ${proposal.localDate} ${proposal.localTime} ${proposal.timeZone} for ${proposal.purpose}. Include those exact date, time and timezone strings in the confirmation question.`),proposal};
      }
    }
    const key=requestKey(call.id,proposal.evidence,proposal.kind);
    await client.query('SELECT tenant_id FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE',[scope.tenantId]);
    const existing=await client.query('SELECT * FROM scheduled_follow_up_tasks WHERE tenant_id=$1 AND request_key=$2',[scope.tenantId,key]);
    if(existing.rowCount)return {scheduled:!['failed','canceled'].includes(existing.rows[0].status),id:existing.rows[0].id,status:existing.rows[0].status,requestedFor:existing.rows[0].requested_for,idempotent:true};
    const delay=new Date(proposal.requestedFor).getTime()-Date.now();
    if(!Number.isFinite(delay) || delay<config.minimumDelaySeconds*1000-2000 || delay>config.maximumDelayDays*86400000)return clarification('time_out_of_range','Ask for a future time within the configured callback window.');
    const duplicate=await client.query(`SELECT id,purpose FROM scheduled_follow_up_tasks WHERE tenant_id=$1 AND conversation_id=$2 AND kind=$3 AND requested_for=$4
      AND status IN ('scheduled','queued','dispatching','initiated')`,[scope.tenantId,stored.conversation_id,proposal.kind,proposal.requestedFor]);
    if(duplicate.rowCount)return {scheduled:false,reason:'duplicate_time',instruction:'A follow-up already exists at this time; clarify before changing it.'};
    let campaignResult;
    if(stored.campaign_task_id){
      campaignResult=await (deps.scheduleCampaign??scheduleCustomerCallback)({callId:call.id,tenantId:scope.tenantId,requestedFor:proposal.requestedFor,requestText:proposal.evidence,...config},
        {contextRunner:operation=>operation(client),...(deps.campaignQueue?{queue:deps.campaignQueue}:{})});
      if(!campaignResult.scheduled && campaignResult.reason!=='queue_unavailable')return {scheduled:false,reason:campaignResult.reason};
      proposal.requestedFor=campaignResult.requestedFor??proposal.requestedFor;
      const mirror=await client.query(`SELECT id FROM scheduled_follow_up_tasks WHERE tenant_id=$1 AND campaign_task_id=$2
        AND campaign_origin_attempt_id=$3 AND status IN ('scheduled','queued','dispatching','initiated')`,[scope.tenantId,stored.campaign_task_id,stored.campaign_attempt_id]);
      if(mirror.rowCount)return {scheduled:true,id:mirror.rows[0].id,requestedFor:proposal.requestedFor,idempotent:true};
    }else await assertOutboundQueueSpace(client,scope.tenantId,1);
    const inserted=await client.query(`INSERT INTO scheduled_follow_up_tasks
      (tenant_id,workspace_id,agent_id,conversation_id,origin_call_session_id,request_key,kind,purpose,requested_for,scheduled_for,time_zone,request_text,campaign_task_id,campaign_origin_attempt_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13) RETURNING *`,
      [scope.tenantId,scope.workspaceId,scope.id,stored.conversation_id,call.id,key,proposal.kind,proposal.purpose,proposal.requestedFor,proposal.timeZone,proposal.evidence,stored.campaign_task_id??null,stored.campaign_attempt_id??null]);
    if(args.action==='confirm')await client.query(`UPDATE call_sessions SET provider_metadata=jsonb_set(provider_metadata,'{followUpProposal}',$2::jsonb,true) WHERE id=$1`,[call.id,JSON.stringify({...proposal,scheduledTaskId:inserted.rows[0].id})]);
    else await client.query("UPDATE call_sessions SET provider_metadata=provider_metadata-'followUpProposal' WHERE id=$1",[call.id]);
    if(campaignResult)await client.query("UPDATE scheduled_follow_up_tasks SET status='queued' WHERE id=$1",[inserted.rows[0].id]);
    await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_type,action,entity_type,entity_id,after_data)
      VALUES($1,$2,'system','FOLLOW_UP_SCHEDULED','scheduled_follow_up_task',$3,$4::jsonb)`,
      [scope.tenantId,scope.workspaceId,inserted.rows[0].id,JSON.stringify({callId:call.id,requestedFor:proposal.requestedFor,kind:proposal.kind})]);
    return {scheduled:true,id:inserted.rows[0].id,status:campaignResult?'queued':'scheduled',requestedFor:proposal.requestedFor,timeZone:proposal.timeZone};
  });
  return result;
}
