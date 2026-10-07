import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
const {updateContactTool,authorizeCallerName,updateCallerContact}=await import('../src/voice/tools/update-contact.service.js');
const {executeAgentTool}=await import('../src/voice/tools/tool-executor.service.js');
const agent={id:'agent',tenantId:'company',workspaceId:'workspace'};
const profile={agent,tools:[updateContactTool]};
const call={id:'call',agentId:agent.id,tenantId:agent.tenantId,workspaceId:agent.workspaceId};
const toolCall={name:'update_contact',arguments:{name:'Ravi',evidence:'My name is Ravi'},currentUserMessage:'My name is Ravi',authorizationRecordId:updateContactTool.id};
assert.equal(authorizeCallerName(toolCall).allowed,true);
for(const text of ['I am calling for Ravi','My mother is Ravi','Her name is Ravi','Ravi','My name is Ravi and my wife is Priya']) {
  assert.equal(authorizeCallerName({...toolCall,currentUserMessage:text,arguments:{name:'Ravi',evidence:text}}).allowed,false);
}
assert.equal(authorizeCallerName({...toolCall,arguments:{name:'Priya',evidence:'My name is Ravi'}}).allowed,false);
assert.equal(authorizeCallerName({...toolCall,currentUserMessage:'என் பெயர் ரவி',arguments:{name:'ரவி',evidence:'என் பெயர் ரவி'}}).allowed,true);
assert.equal(authorizeCallerName({...toolCall,currentUserMessage:'Yes',arguments:{name:'Ravi',evidence:'Yes'}}).allowed,false);
const nameReply={...toolCall,currentUserMessage:'Ravi',arguments:{name:'Ravi',evidence:'Ravi'},conversation:[{role:'assistant',content:'What is your name?'}]};
assert.equal(authorizeCallerName(nameReply).allowed,true);
assert.equal(authorizeCallerName({...nameReply,conversation:[{role:'assistant',content:'What is your patient name?'}]}).allowed,false);
const confirmed={...toolCall,currentUserMessage:'Yes',arguments:{name:'Ravi',evidence:'Yes'},conversation:[
  {role:'user',content:'My name is Ravi'},{role:'assistant',content:'Should I update your saved caller name to Ravi?'}]};
assert.equal(authorizeCallerName(confirmed).confirmedReplacement,true);
assert.equal(authorizeCallerName({...confirmed,conversation:[{role:'user',content:'Her name is Ravi'},{role:'assistant',content:'Should I update your saved caller name to Ravi?'}]}).allowed,false);
let existing=null,writes=0,audits=0;
let stored={direction:'inbound',from_number:'+919123456789',to_number:'+918000000000',status:'connected',provider_metadata:{}};
let selectedPhone;
const contextRunner=async operation=>operation({query:async(sql,args)=> {
  if(sql.startsWith('SET LOCAL'))return {};
  if(sql.includes('FROM call_sessions')) {assert.deepEqual(args,[call.id,agent.tenantId,agent.workspaceId,agent.id]);return {rows:stored?[stored]:[]};}
  if(sql.includes('pg_advisory'))return {};
  if(sql.includes('SELECT id,display_name')) {assert.equal(args[0],agent.tenantId);selectedPhone=args[1];return {rows:existing?[existing]:[]};}
  if(sql.includes('INSERT INTO conversation_contacts')) {
    writes++;assert.equal(args[0],agent.tenantId);assert.equal(args[1],selectedPhone);
    existing={id:'contact',display_name:args[2]};return {rows:[existing]};
  }
  if(sql.includes('INSERT INTO audit_logs')) {audits++;return {};}
  throw new Error('Unexpected SQL');
}});
await assert.rejects(updateCallerContact(profile,call,toolCall,{contextRunner}),error=>error.code==='CONTACT_UPDATE_NOT_AUTHORIZED');
await assert.rejects(executeAgentTool(profile,call,toolCall,{contactContextRunner:contextRunner}),error=>error.code==='CONTACT_UPDATE_NOT_AUTHORIZED');
const dependencies={requireWorkflowAuthorization:true,workflowAuthorization:{recordId:updateContactTool.id,toolName:'update_contact'},contactContextRunner:contextRunner};
const saved=await executeAgentTool(profile,call,toolCall,dependencies);
assert.equal(saved.output.saved,true);assert.equal(saved.output.identityVerified,false);
assert.equal(writes,1);assert.equal(audits,1);assert.equal(selectedPhone,stored.from_number);
await executeAgentTool(profile,call,toolCall,dependencies);assert.equal(writes,1);
existing={id:'contact',display_name:'Priya'};
const conflict=await executeAgentTool(profile,call,toolCall,dependencies);
assert.equal(conflict.output.saved,false);assert.equal(conflict.output.reason,'name_conflict');
assert.ok(!JSON.stringify(conflict.output).includes('Priya'));assert.equal(writes,1);
const replaced=await executeAgentTool(profile,call,confirmed,dependencies);
assert.equal(replaced.output.saved,true);assert.equal(existing.display_name,'Ravi');assert.equal(writes,2);
await assert.rejects(updateCallerContact(profile,{...call,tenantId:'other-company'},toolCall,{authorized:true,contextRunner}),e=>e.code==='CONTACT_UPDATE_SCOPE_INVALID');
stored={...stored,direction:'outbound'};existing=null;
await executeAgentTool(profile,call,toolCall,dependencies);assert.equal(selectedPhone,stored.to_number);
stored={...stored,provider_metadata:{source:'browser_test'}};
await assert.rejects(executeAgentTool(profile,call,toolCall,dependencies),e=>e.code==='CONTACT_UPDATE_CALL_UNAVAILABLE');
stored={...stored,provider_metadata:{},status:'completed'};
await assert.rejects(executeAgentTool(profile,call,toolCall,dependencies),e=>e.code==='CONTACT_UPDATE_CALL_UNAVAILABLE');
const unsafe={...toolCall,arguments:{...toolCall.arguments,phone:'+919999999999'}};
await assert.rejects(executeAgentTool(profile,call,unsafe,dependencies));
console.log('PASS update_contact: own-name evidence, third-party rejection, Tamil, conflict confirmation, idempotency, audit, authorization, tenant/workspace scope, outbound recipient, browser/closed-call protection and strict arguments');
