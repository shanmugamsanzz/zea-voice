import { withPlatformAdminContext } from '../../infrastructure/database-context.js';
import { AppError } from '../../middleware/errors.js';

export const updateContactTool = Object.freeze({
  id:'builtin:update_contact',name:'update_contact',type:'internal_contact',
  description:'Save only the current caller\'s explicitly stated own name. Use EXECUTE after a complete self-identification, never for a relative, patient, colleague, or someone they call for. Decide self-identification and confirmation from the conversation in any language, not fixed keywords. Supply evidence from the current caller message, nameEvidence containing the stated name, callerOwnNameConfirmed, and confirmedReplacement. If saved=false, ask the clarification question; never claim the name was saved. For a conflict ask whether to update the saved caller name, then invoke again only after confirmation.',
  configuration:{inputSchema:{type:'object',additionalProperties:false,required:['name','evidence','nameEvidence','callerOwnNameConfirmed','confirmedReplacement'],properties:{
    name:{type:'string',minLength:1,maxLength:240},evidence:{type:'string',minLength:1,maxLength:2000},
    nameEvidence:{type:'string',minLength:1,maxLength:2000,description:'Exact quote from a current or recent caller message containing their own stated name.'},
    callerOwnNameConfirmed:{type:'boolean',description:'True only when the conversation clearly establishes this is the current caller own name, not another person name.'},
    confirmedReplacement:{type:'boolean',description:'True only when the current caller explicitly confirms replacing their saved name with this name; otherwise false.'},
  }}},
});
export const contactNameInstructions = 'The built-in update_contact tool saves the caller name immediately. When a caller explicitly states their own name, use EXECUTE with that name, an exact current-caller quote in evidence, an exact caller quote containing the name in nameEvidence, callerOwnNameConfirmed=true, and confirmedReplacement=false. Interpret the conversation in its language without requiring specific identification or confirmation words. Set confirmedReplacement=true only when the current caller clearly authorizes replacing the saved name with this name, including a clear correction request. Do not save names of people they mention or call for. Ambiguous names require clarification. A saved=false result means no name was written: ask the supplied clarification question. Never claim success until output.saved=true. A conflicting existing name needs a separate confirmation before replacement; never reveal the existing saved name. This records a name, not verified identity.';
const normalize=value=>String(value??'').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim();
const same=(a,b)=>normalize(a).toLocaleLowerCase()===normalize(b).toLocaleLowerCase();
export function authorizeCallerName(toolCall) {
  const args=toolCall.arguments??{};
  const name=normalize(args.name);
  const evidence=normalize(args.evidence);
  const nameEvidence=normalize(args.nameEvidence);
  const current=normalize(toolCall.currentUserMessage);
  if(!name||Array.from(name).length>240||! /^[\p{L}\p{M}][\p{L}\p{M} .,'\u2019\-]{0,239}$/u.test(name)) {
    return {allowed:false,reason:'name_not_understood'};
  }
  // The LLM interprets ownership and confirmation. Code checks the structured
  // decision and grounds its evidence in caller messages, without phrase lists.
  if(args.callerOwnNameConfirmed!==true||typeof args.confirmedReplacement!=='boolean'
    ||!evidence||evidence.length>2000||!current.includes(evidence)
    ||!nameEvidence||nameEvidence.length>2000
    ||!nameEvidence.toLocaleLowerCase().includes(name.toLocaleLowerCase())) {
    return {allowed:false,reason:'caller_identity_unclear'};
  }
  const history=(Array.isArray(toolCall.conversation)?toolCall.conversation:[]).slice(-12);
  const callerMessages=[current,...history.filter(entry=>entry.role==='user').map(entry=>normalize(entry.content))];
  if(!callerMessages.some(message=>message.includes(nameEvidence))) {
    return {allowed:false,reason:'caller_identity_unclear'};
  }
  return {allowed:true,name,confirmedReplacement:args.confirmedReplacement};
}
export async function updateCallerContact(runtimeProfile,call,toolCall,dependencies={}) {
  if(dependencies.authorized!==true)throw new AppError(403,'Contact update is not authorized','CONTACT_UPDATE_NOT_AUTHORIZED');
  const authorization=authorizeCallerName(toolCall);
  if(!authorization.allowed)return {saved:false,clarificationRequired:true,reason:authorization.reason,
    instruction:'Ask the caller to explicitly state their own name. Do not save names of other people.'};
  const scope=runtimeProfile.agent;
  if(call.tenantId!==scope.tenantId||call.workspaceId!==scope.workspaceId||call.agentId!==scope.id) {
    throw new AppError(403,'Contact update scope does not match the call','CONTACT_UPDATE_SCOPE_INVALID');
  }
  const runner=dependencies.contextRunner??(operation=>withPlatformAdminContext(null,operation));
  return runner(async client=> {
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const found=await client.query(`SELECT direction,from_number,to_number,provider_metadata,status
      FROM call_sessions WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND agent_id=$4 FOR UPDATE`,
    [call.id,scope.tenantId,scope.workspaceId,scope.id]);
    const stored=found.rows[0];
    if(!stored||!['ringing','connected'].includes(stored.status)||stored.provider_metadata?.source==='browser_test') {
      throw new AppError(409,'Contact names can only be saved during a live phone call','CONTACT_UPDATE_CALL_UNAVAILABLE');
    }
    const phone=stored.direction==='inbound'?stored.from_number:stored.to_number;
    if(!/^\+[1-9][0-9]{6,14}$/.test(phone??''))throw new AppError(409,'Call contact number unavailable','CONTACT_UPDATE_PHONE_UNAVAILABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.tenantId}:${phone}`]);
    const previous=(await client.query('SELECT id,display_name FROM conversation_contacts WHERE tenant_id=$1 AND phone_e164=$2 FOR UPDATE',[scope.tenantId,phone])).rows[0];
    if(previous?.display_name&&!same(previous.display_name,authorization.name)&&!authorization.confirmedReplacement) {
      return {saved:false,clarificationRequired:true,reason:'name_conflict',
        proposedName:authorization.name,instruction:`Ask: Should I update your saved caller name to ${authorization.name}? Do not reveal the existing name.`};
    }
    if(previous?.display_name&&same(previous.display_name,authorization.name))return {saved:true,unchanged:true,contactId:previous.id,name:previous.display_name,identityVerified:false};
    const saved=(await client.query(`INSERT INTO conversation_contacts(tenant_id,phone_e164,display_name,name_source,name_updated_at)
      VALUES ($1,$2,$3,'caller',now()) ON CONFLICT(tenant_id,phone_e164) DO UPDATE
      SET display_name=EXCLUDED.display_name,name_source='caller',name_updated_at=now() RETURNING id,display_name`,
    [scope.tenantId,phone,authorization.name])).rows[0];
    await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_type,action,entity_type,entity_id,after_data)
      VALUES ($1,$2,'system','CONTACT_NAME_UPDATED','conversation_contact',$3,$4::jsonb)`,
    [scope.tenantId,scope.workspaceId,saved.id,JSON.stringify({callId:call.id,agentId:scope.id,name:authorization.name,source:'caller'})]);
    return {saved:true,contactId:saved.id,name:saved.display_name,identityVerified:false};
  });
}
