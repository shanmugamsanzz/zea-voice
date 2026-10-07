import { withPlatformAdminContext } from '../../infrastructure/database-context.js';
import { AppError } from '../../middleware/errors.js';

export const updateContactTool = Object.freeze({
  id:'builtin:update_contact',name:'update_contact',type:'internal_contact',
  description:'Save only the current caller\'s explicitly stated own name. Use EXECUTE after a complete self-identification, never for a relative, patient, colleague, or someone they call for. Supply the exact caller evidence. If saved=false, ask the clarification question; never claim the name was saved. For a conflict ask whether to update the saved caller name, then invoke again only after confirmation.',
  configuration:{inputSchema:{type:'object',additionalProperties:false,required:['name','evidence'],properties:{
    name:{type:'string',minLength:1,maxLength:240},evidence:{type:'string',minLength:1,maxLength:2000},
  }}},
});
export const contactNameInstructions = 'The built-in update_contact tool saves the caller name immediately. When a caller explicitly states their own name, use EXECUTE with that name and an exact quote in evidence. Do not save names of people they mention or call for. Ambiguous names require clarification. A saved=false result means no name was written: ask the supplied clarification question. Never claim success until output.saved=true. A conflicting existing name needs a separate confirmation before replacement; never reveal the existing saved name. This records a name, not verified identity.';
const normalize=value=>String(value??'').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim();
const same=(a,b)=>normalize(a).toLocaleLowerCase()===normalize(b).toLocaleLowerCase();
const thirdParty=/(?:calling (?:for|on behalf)|my (?:mother|father|wife|husband|son|daughter|brother|sister|friend|colleague|patient)|['’]s (?:mother|father|wife|husband|son|daughter)|(?:his|her|their) name|அவருடைய பெயர்|அவங்க பெயர்)/iu;
function ownName(text,name) {
  const value=normalize(text);
  if(thirdParty.test(value))return false;
  const match=value.match(/^(?:my name is|i am|i'm|this is|என் பெயர்|என்னுடைய பெயர்|en peyar|ennoda peru|en peru)\s+(.+?)[.!?।]*$/iu);
  return Boolean(match&&same(match[1],name));
}
const ownNameQuestion=text=>/^(?:what(?: is|'s) your (?:full )?name|(?:may|can) i (?:know|have|get) your (?:full )?name|உங்கள் பெயர் என்ன|உங்க பெயர் என்ன)[?!.]*$/iu.test(normalize(text));
export function authorizeCallerName(toolCall) {
  const name=normalize(toolCall.arguments?.name);
  const evidence=normalize(toolCall.arguments?.evidence);
  const current=normalize(toolCall.currentUserMessage);
  if(!name||Array.from(name).length>240||! /^[\p{L}\p{M}][\p{L}\p{M} .,'’\-]{0,239}$/u.test(name)) {
    return {allowed:false,reason:'name_not_understood'};
  }
  if(!evidence||!current.includes(evidence)||thirdParty.test(current))return {allowed:false,reason:'caller_identity_unclear'};
  if(ownName(current,name))return {allowed:true,name,confirmedReplacement:false};
  const history=(Array.isArray(toolCall.conversation)?toolCall.conversation:[]).slice(-12);
  const assistant=history.filter(entry=>entry.role==='assistant').at(-1);
  if(same(current,name)&&ownNameQuestion(assistant?.content))return {allowed:true,name,confirmedReplacement:false};
  const directCorrection=current.match(/^(?:yes[, ]+)?(?:please )?(?:change|update|correct) my name to\s+(.+?)[.!?]*$/iu);
  if(directCorrection&&same(directCorrection[1],name))return {allowed:true,name,confirmedReplacement:true};
  const confirmed=/^(?:yes|yes please|yes that is correct|சரி|ஆம்|ஆமாம்)[.!?]*$/iu.test(current);
  const question=normalize(assistant?.content);
  const ownEvidence=history.some((entry,index)=>entry.role==='user'&&(
    ownName(entry.content,name)||(same(entry.content,name)&&history[index-1]?.role==='assistant'&&ownNameQuestion(history[index-1].content))));
  if(confirmed&&ownEvidence&&question.toLocaleLowerCase().includes(name.toLocaleLowerCase())
    &&/(?:update|change|correct).*(?:your|saved|caller).*name|பெயர.*(?:மாற்ற|புதுப்பி)|(?:மாற்ற|புதுப்பி).*பெயர/iu.test(question)&&question.includes('?')) {
    return {allowed:true,name,confirmedReplacement:true};
  }
  return {allowed:false,reason:'caller_identity_unclear'};
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
