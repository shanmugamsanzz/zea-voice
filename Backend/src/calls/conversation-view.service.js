import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

export function conversationScope(auth, companyId) {
  if (!auth) throw new AppError(401,'Authentication is required','UNAUTHENTICATED');
  if (!['SUPER_ADMIN','COMPANY_DEVELOPER','COMPANY_USER'].includes(auth.role)) throw new AppError(403,'Conversation access is not permitted','FORBIDDEN');
  if (auth.role==='SUPER_ADMIN') {
    if (!companyId) throw new AppError(400,'Select a company','COMPANY_REQUIRED');
    return {tenantId:companyId,workspaceId:null};
  }
  if (!auth.tenantId || !auth.workspaceId) throw new AppError(403,'Company membership is required','NO_ACTIVE_MEMBERSHIP');
  if (companyId && companyId!==auth.tenantId) throw new AppError(403,'Cross-company access is not allowed','TENANT_ACCESS_DENIED');
  return {tenantId:auth.tenantId,workspaceId:auth.workspaceId};
}
function run(auth, operation, dependencies) {
  return (dependencies.contextRunner ?? (op=>auth.role==='SUPER_ADMIN'
    ? withPlatformAdminContext(auth.userId,op) : withTenantContext(auth,op)))(operation);
}
const visibleCall=`c.tenant_id=$1 AND ($2::uuid IS NULL OR c.workspace_id=$2)`;
const pageResult=(rows,page,pageSize)=>({items:rows.slice(0,pageSize),page,hasMore:rows.length>pageSize});
async function thread(client,scope,id) {
  const result=await client.query(`SELECT cv.id,ct.display_name AS "name",ct.phone_e164 AS "phone"
    FROM contact_conversations cv JOIN conversation_contacts ct ON ct.id=cv.contact_id AND ct.tenant_id=cv.tenant_id
    WHERE cv.id=$3 AND cv.tenant_id=$1 AND EXISTS(SELECT 1 FROM conversation_call_links l
      JOIN call_sessions c ON c.id=l.call_session_id AND c.tenant_id=l.tenant_id
      WHERE l.conversation_id=cv.id AND l.tenant_id=cv.tenant_id AND ${visibleCall})`,[scope.tenantId,scope.workspaceId,id]);
  if(!result.rowCount)throw new AppError(404,'Conversation was not found','CONVERSATION_NOT_FOUND');
  return result.rows[0];
}
export function listConversations(auth,filters,dependencies={}) {
  const scope=conversationScope(auth,filters.companyId);
  return run(auth,async client=>{
    const result=await client.query(`SELECT cv.id,ct.display_name AS "name",ct.phone_e164 AS "phone",
      stats.call_count AS "callCount",stats.last_call_at AS "lastCallAt"
      FROM contact_conversations cv JOIN conversation_contacts ct ON ct.id=cv.contact_id AND ct.tenant_id=cv.tenant_id
      JOIN LATERAL(SELECT count(*)::int AS call_count,max(c.started_at) AS last_call_at
        FROM conversation_call_links l JOIN call_sessions c ON c.id=l.call_session_id AND c.tenant_id=l.tenant_id
        WHERE l.conversation_id=cv.id AND l.tenant_id=cv.tenant_id AND ${visibleCall}) stats ON stats.call_count>0
      WHERE cv.tenant_id=$1 AND ($3::text IS NULL OR ct.display_name ILIKE '%'||$3||'%' OR ct.phone_e164 ILIKE '%'||$3||'%')
      ORDER BY stats.last_call_at DESC,cv.id LIMIT $4 OFFSET $5`,
    [scope.tenantId,scope.workspaceId,filters.search??null,filters.pageSize+1,(filters.page-1)*filters.pageSize]);
    return pageResult(result.rows,filters.page,filters.pageSize);
  },dependencies);
}
export function getConversation(auth,id,filters,dependencies={}) {
  const scope=conversationScope(auth,filters.companyId);
  return run(auth,async client=>{
    const contact=await thread(client,scope,id);
    const calls=await client.query(`SELECT c.id,c.direction,c.status,c.agent_name AS "agentName",c.campaign_name AS "campaignName",
      c.started_at AS "startedAt",c.ended_at AS "endedAt",c.duration_seconds AS "durationSeconds",
      s.status AS "summaryStatus",s.summary_text AS "summary",s.outcome,s.customer_intent AS "customerIntent",
      s.collected_data AS "collectedData",s.follow_up_required AS "followUpRequired",s.follow_up_reason AS "followUpReason"
      FROM conversation_call_links l JOIN call_sessions c ON c.id=l.call_session_id AND c.tenant_id=l.tenant_id
      LEFT JOIN call_ai_summaries s ON s.call_session_id=c.id AND s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id
      WHERE l.conversation_id=$3 AND l.tenant_id=$1 AND ${visibleCall}
      ORDER BY c.started_at,c.id LIMIT $4 OFFSET $5`,
      [scope.tenantId,scope.workspaceId,id,filters.pageSize+1,(filters.page-1)*filters.pageSize]);
    const followUps=await client.query(`SELECT t.id,t.kind,t.purpose,t.status,t.scheduled_for AS "scheduledFor",
      a.name AS "agentName" FROM scheduled_follow_up_tasks t
      JOIN voice_agents a ON a.id=t.agent_id AND a.tenant_id=t.tenant_id AND a.workspace_id=t.workspace_id
      WHERE t.tenant_id=$1 AND ($2::uuid IS NULL OR t.workspace_id=$2) AND t.conversation_id=$3
        AND t.status IN ('scheduled','queued','dispatching','initiated')
      ORDER BY t.scheduled_for,t.id LIMIT $4 OFFSET $5`,
      [scope.tenantId,scope.workspaceId,id,26,(filters.followUpPage-1)*25]);
    return {contact,calls:pageResult(calls.rows,filters.page,filters.pageSize),followUps:pageResult(followUps.rows,filters.followUpPage,25)};
  },dependencies);
}
export function getConversationTranscript(auth,id,callId,filters,dependencies={}) {
  const scope=conversationScope(auth,filters.companyId);
  return run(auth,async client=>{
    await thread(client,scope,id);
    const call=await client.query(`SELECT c.id,c.direction,c.status,c.started_at AS "startedAt"
      FROM conversation_call_links l JOIN call_sessions c ON c.id=l.call_session_id AND c.tenant_id=l.tenant_id
      WHERE l.conversation_id=$3 AND l.tenant_id=$1 AND c.id=$4 AND ${visibleCall}`,
      [scope.tenantId,scope.workspaceId,id,callId]);
    if(!call.rowCount)throw new AppError(404,'Call was not found in this conversation','CALL_NOT_FOUND');
    const result=await client.query(`SELECT t.id,t.sequence_number AS "sequenceNumber",t.speaker,t.text,t.created_at AS "createdAt"
      FROM call_transcript_entries t JOIN call_sessions c ON c.id=t.call_session_id AND c.tenant_id=t.tenant_id
      WHERE t.call_session_id=$3 AND t.is_final=true AND ${visibleCall}
      ORDER BY t.sequence_number,t.id LIMIT $4 OFFSET $5`,
      [scope.tenantId,scope.workspaceId,callId,filters.pageSize+1,(filters.page-1)*filters.pageSize]);
    return {call:call.rows[0],transcript:pageResult(result.rows,filters.page,filters.pageSize)};
  },dependencies);
}
