import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
const {runAgentQdrantUniversalTurn}=await import('../src/voice/interaction/agent-qdrant-grounded-turn.js');
const retrieval={request:{tenantId:'t',agentId:'a',previousContext:[]},chunks:[],diagnostics:{}};
const good={outcome:'CONVERSATIONAL_RESPONSE',speech:'The doctor is Dr. Nithya Manoj.',workflowAction:null,languageChange:null};
const bad={...good,workflowAction:{action:'EXECUTE',toolName:'bad'}};
async function run(outputs,{abort=false}={}) {
 let calls=0,spoken=[];const controller=new AbortController();
 const task=runAgentQdrantUniversalTurn({retrieval,currentQuestion:'Doctor name?',language:'en',workflowDefinitions:[{toolName:'example'}],cancellationSignal:controller.signal,onSpeechSentence:s=>spoken.push(s)}, {
  invokeStructuredLlm:async(request,options)=>{
   calls++;
   options.onSpeechSentence?.('Unvalidated speech must not play.');
   if(calls===1 && abort)controller.abort();
   return {outputParsed:outputs[calls-1]};
  }
 });
 return {result:await task,calls,spoken};
}
const recovered=await run([bad,good]);
assert.equal(recovered.calls,2);assert.equal(recovered.result.correctionAttempts,1);
assert.equal(recovered.result.workflowAction,null);assert.equal(recovered.result.speech,good.speech);assert.deepEqual(recovered.spoken,[]);
await assert.rejects(run([bad,bad]),e=>e.code==='QDRANT_UNIVERSAL_LLM_CORRECTION_FAILED');
await assert.rejects(run([bad],{abort:true}),e=>e.name==='AbortError');
const normal=await run([good]);assert.equal(normal.calls,1);assert.equal(normal.result.correctionAttempts,0);
console.log('PASS single bounded speech-only correction, blocked repeated action, no partial speech, cancellation and unchanged valid path');
