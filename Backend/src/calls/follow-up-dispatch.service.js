import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { isCompanyCallQueueEnabled } from '../queues/company-queue-feature.js';
import { getQueue } from '../queues/queue.registry.js';
import { isConversationContinuityEnabled } from './conversation-feature.js';

// A persisted mirror is an outbox for the existing campaign queue. Stable job
// identifiers and the campaign task lock prevent a second retry or dial.
export async function recoverCampaignFollowUps(deps={}) {
  const run=deps.contextRunner??(operation=>withPlatformAdminContext(null,operation));
  const tasks=await run(async client=>(await client.query(`SELECT c.id,c.tenant_id,c.workspace_id,c.campaign_id,c.retry_count
    FROM campaign_tasks c JOIN scheduled_follow_up_tasks t ON t.campaign_task_id=c.id AND t.tenant_id=c.tenant_id
      AND t.workspace_id=c.workspace_id AND t.campaign_origin_attempt_id=c.callback_origin_attempt_id
    WHERE c.status='queued' AND t.status='queued' AND c.scheduled_for<=now()
    ORDER BY c.scheduled_for,c.id LIMIT 100`)).rows);
  let recovered=0;
  for(const task of tasks){
    if(!(deps.featureEnabled??isConversationContinuityEnabled)(task.tenant_id))continue;
    if(!(deps.queueEnabled??isCompanyCallQueueEnabled)(task.tenant_id))continue;
    await (deps.queue??getQueue('call-retries')).add('campaign-task',{
      taskId:task.id,tenantId:task.tenant_id,workspaceId:task.workspace_id,campaignId:task.campaign_id,
    },{jobId:`${task.id}-callback-${task.retry_count}`,removeOnComplete:1000,removeOnFail:5000});
    recovered++;
  }
  return recovered;
}

export async function enqueueDueFollowUps(deps={}) {
  const run=deps.contextRunner??(operation=>withPlatformAdminContext(null,operation));
  await run(client=>client.query(`UPDATE scheduled_follow_up_tasks t SET status='failed',last_error_code='FOLLOW_UP_RESULT_UNCONFIRMED',finished_at=now()
    FROM agent_phone_test_requests r WHERE r.follow_up_task_id=t.id AND r.tenant_id=t.tenant_id
      AND t.status='initiated' AND r.updated_at<now()-interval '2 hours'
      AND NOT EXISTS(SELECT 1 FROM follow_up_call_attempts a WHERE a.follow_up_task_id=t.id)`));
  const candidates=await run(async client=>(await client.query(`SELECT id,tenant_id FROM scheduled_follow_up_tasks
    WHERE status='scheduled' AND campaign_task_id IS NULL AND scheduled_for<=now()
    ORDER BY scheduled_for,id LIMIT 100`)).rows);
  let enqueued=0;
  for(const candidate of candidates){
    if(!(deps.featureEnabled??isConversationContinuityEnabled)(candidate.tenant_id))continue;
    if(!(deps.queueEnabled??isCompanyCallQueueEnabled)(candidate.tenant_id))continue;
    const queued=await run(async client=>{
      await client.query('SELECT tenant_id FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE',[candidate.tenant_id]);
      const result=await client.query(`SELECT t.*,ct.phone_e164 FROM scheduled_follow_up_tasks t
        JOIN contact_conversations cv ON cv.id=t.conversation_id AND cv.tenant_id=t.tenant_id
        JOIN conversation_contacts ct ON ct.id=cv.contact_id AND ct.tenant_id=cv.tenant_id
        WHERE t.id=$1 AND t.tenant_id=$2 AND t.status='scheduled' AND t.scheduled_for<=now()
          AND t.campaign_task_id IS NULL FOR UPDATE OF t SKIP LOCKED`,[candidate.id,candidate.tenant_id]);
      if(!result.rowCount)return false;
      const task=result.rows[0];
      await client.query(`INSERT INTO agent_phone_test_requests(tenant_id,workspace_id,agent_id,created_by,request_key,phone,status,queue_reason,follow_up_task_id)
        VALUES($1,$2,$3,$4,$5,$6,'queued','company_capacity',$5)
        ON CONFLICT(follow_up_task_id) WHERE follow_up_task_id IS NOT NULL DO NOTHING`,
        [task.tenant_id,task.workspace_id,task.agent_id,task.created_by,task.id,task.phone_e164]);
      await client.query("UPDATE scheduled_follow_up_tasks SET status='queued' WHERE id=$1 AND status='scheduled'",[task.id]);
      return true;
    });
    if(queued)enqueued++;
  }
  return enqueued;
}

export async function bindFollowUpCall(reservationId,call,deps={}) {
  if(!reservationId)return false;
  const run=deps.contextRunner??(operation=>withPlatformAdminContext(null,operation));
  return run(async client=>{
    const result=await client.query(`SELECT t.*,r.phone FROM agent_phone_test_requests r JOIN scheduled_follow_up_tasks t
      ON t.id=r.follow_up_task_id AND t.tenant_id=r.tenant_id AND t.workspace_id=r.workspace_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.workspace_id=$3 AND r.agent_id=$4 FOR UPDATE OF t`,
      [reservationId,call.tenantId,call.workspaceId,call.agentId]);
    if(!result.rowCount)return false;
    const task=result.rows[0];
    if(call.direction!=='outbound'||(call.toNumber??call.to)!==task.phone)throw new Error('Follow-up call recipient mismatch');
    await client.query(`INSERT INTO follow_up_call_attempts(tenant_id,workspace_id,follow_up_task_id,call_session_id,attempt_number)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(call_session_id) DO NOTHING`,[task.tenant_id,task.workspace_id,task.id,call.id]);
    await client.query('UPDATE conversation_call_links SET call_purpose=left($3,80) WHERE call_session_id=$1 AND tenant_id=$2',[call.id,task.tenant_id,task.purpose]);
    await client.query("UPDATE scheduled_follow_up_tasks SET status='initiated' WHERE id=$1 AND status IN ('queued','dispatching','initiated')",[task.id]);
    return true;
  });
}

// Called only after validateIncomingPlivoCall has authenticated the hangup.
export async function finishValidatedFollowUp(reservationId,call,payload,deps={}) {
  const run=deps.contextRunner??(operation=>withPlatformAdminContext(null,operation));
  return run(async client=>{
    const result=await client.query(`SELECT t.*,r.phone,a.name AS agent_name,a.phone_number_id FROM agent_phone_test_requests r
      JOIN scheduled_follow_up_tasks t ON t.id=r.follow_up_task_id AND t.tenant_id=r.tenant_id AND t.workspace_id=r.workspace_id
      JOIN voice_agents a ON a.id=r.agent_id AND a.tenant_id=r.tenant_id AND a.workspace_id=r.workspace_id
      WHERE r.id=$1 AND r.tenant_id=$2 FOR UPDATE OF t`,[reservationId,call.capacityTenantId]);
    if(!result.rowCount)return false;
    const task=result.rows[0];
    if(call.direction!=='outbound'||call.to!==task.phone)throw new Error('Follow-up hangup recipient mismatch');
    const previous=await client.query('SELECT id FROM follow_up_call_attempts WHERE follow_up_task_id=$1',[task.id]);
    const raw=String(payload.HangupCauseName??payload.CallStatus??'').toLowerCase().replace(/[ -]/g,'_');
    const status=/busy/.test(raw)?'busy':/no_?answer|noanswer/.test(raw)?'no_answer':/cancel/.test(raw)?'canceled'
      : /complete|normal/.test(raw)?'completed':'failed';
    if(!previous.rowCount){
      const existing=await client.query(`SELECT id,workspace_id,agent_id,from_number,to_number FROM call_sessions
        WHERE tenant_id=$1 AND telephony_account_id=$2 AND provider_call_id=$3 FOR UPDATE`,[task.tenant_id,call.telephonyAccountId,call.providerCallId]);
      if(existing.rowCount && (existing.rows[0].workspace_id!==task.workspace_id || existing.rows[0].agent_id!==task.agent_id
        || existing.rows[0].from_number!==call.from || existing.rows[0].to_number!==call.to))throw new Error('Follow-up call identity mismatch');
      // Unanswered calls have no media session; keep their own result record.
      const inserted=existing.rowCount?existing:await client.query(`INSERT INTO call_sessions(tenant_id,workspace_id,agent_id,agent_name,telephony_account_id,phone_number_id,
        provider_call_id,from_number,to_number,direction,status,ended_at,provider_metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'outbound',$10::call_status,now(),$11::jsonb) RETURNING id`,
        [task.tenant_id,task.workspace_id,task.agent_id,task.agent_name,call.telephonyAccountId,call.phoneNumberId,call.providerCallId,
          call.from,call.to,status,JSON.stringify({source:'follow_up',capacityReservationId:reservationId,plivoHangup:payload})]);
      await client.query(`INSERT INTO follow_up_call_attempts(tenant_id,workspace_id,follow_up_task_id,call_session_id,attempt_number)
        VALUES($1,$2,$3,$4,1) ON CONFLICT(call_session_id) DO NOTHING`,[task.tenant_id,task.workspace_id,task.id,inserted.rows[0].id]);
      await client.query('UPDATE conversation_call_links SET call_purpose=left($3,80) WHERE call_session_id=$1 AND tenant_id=$2',[inserted.rows[0].id,task.tenant_id,task.purpose]);
    }
    await client.query(`UPDATE scheduled_follow_up_tasks SET status=$2,finished_at=now()
      WHERE id=$1 AND status IN ('queued','dispatching','initiated')`,[task.id,status]);
    return true;
  });
}
