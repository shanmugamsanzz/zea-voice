import assert from 'node:assert/strict';
import { normalizeResponseLanguage, acceptedLanguageChange } from '../src/voice/interaction/response-language.js';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
assert.equal(normalizeResponseLanguage('Tamil (India)'), 'ta');
assert.equal(normalizeResponseLanguage('English (US)'), 'en');
assert.equal(normalizeResponseLanguage('ta-IN'), 'ta');
assert.equal(acceptedLanguageChange({language:'en',requestQuote:'Speak English'},'hello'),null);
const retrieval={request:{tenantId:'t',agentId:'a',previousContext:[]},chunks:[],diagnostics:{}};
let language='ta';
async function turn(question, change, expected) {
 const result=await runAgentQdrantUniversalTurn({retrieval,currentQuestion:question,language,
   previousContext:[],workflowDefinitions:[],onResponseLanguage:value=>{language=value;}}, {
   invokeStructuredLlm:async request=>{
     assert.ok(request.messages[0].content.includes('Persistent response language: '+language));
     return {outputParsed:{outcome:'CONVERSATIONAL_RESPONSE',speech:'Test response.',workflowAction:null,languageChange:change}};
   }
 });
 assert.equal(result.responseLanguage,expected);assert.equal(language,expected);
}
await turn('Can you speak English?',{language:'en',requestQuote:'Can you speak English?'},'en');
await turn('sari nga',null,'en');
await turn('next question',null,'en');
await turn('Tamil-la pesunga',{language:'ta',requestQuote:'Tamil-la pesunga'},'ta');
await turn('hello',{language:'hi',requestQuote:'not in this utterance'},'ta');
const other=await runAgentQdrantUniversalTurn({retrieval,currentQuestion:'hello',language:'te',workflowDefinitions:[]},{invokeStructuredLlm:async()=>({outputParsed:{outcome:'CONVERSATIONAL_RESPONSE',speech:'Hello.',workflowAction:null}})});
assert.equal(other.responseLanguage,'te');assert.equal(language,'ta');
console.log('PASS language labels, explicit requests, history-independent persistence, invalid quotes and isolated calls');
