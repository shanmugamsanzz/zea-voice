import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';process.env.REDIS_HOST ??= 'localhost';
const {resolveOpenAiRequestOptions,openAiGenerationParameters}=await import('../src/llm/openai-request-options.js');
const {normalizedModelSettings}=await import('../src/providers/model-settings.js');
const {llmTokenBudgetForSpeech}=await import('../src/voice/interaction/template-engine-speech-budget.js');
const {createOpenAiCompatibleLlmAdapter}=await import('../src/voice/providers/llm/openai-compatible.adapter.js');
const {resolveLlmConfiguration,invokeAgentLlm}=await import('../src/llm/llm.client.js');
const budget=llmTokenBudgetForSpeech(708);assert.equal(budget,1608);
const modern={max_completion_tokens:'2000',reasoning_effort:'none',supportsTemperature:'false',untrusted_override:'ignored',model:'override',stream:'false'};
assert.deepEqual(openAiGenerationParameters(resolveOpenAiRequestOptions({}),{temperature:0,maxOutputTokens:99}),{temperature:0,max_tokens:99});
assert.deepEqual(openAiGenerationParameters(resolveOpenAiRequestOptions(modern),{temperature:0,maxOutputTokens:budget}),{max_completion_tokens:1608,reasoning_effort:'none'});
for(const bad of [{outputTokenParameter:'max_output_tokens'},{supportsTemperature:'maybe'},{reasoning_effort:'unbounded'}])assert.throws(()=>normalizedModelSettings({settings:bad}));
assert.equal(resolveOpenAiRequestOptions({supportsTemperature:'yes'}).supportsTemperature,true);
assert.equal(resolveOpenAiRequestOptions({outputTokenParameter:'max_tokens',max_completion_tokens:2000}).tokenParameter,'max_tokens');
assert.equal(resolveOpenAiRequestOptions(normalizedModelSettings({removedSettingsKeys:['reasoning_effort']},modern)).reasoningEffort,undefined);
const provider={providerId:'p',providerName:'OpenAI',modelId:'m',modelKey:'gpt-6-luna',baseUrl:'https://api.openai.com/v1',parameters:{OPENAI_API_KEY:'test-only'},modelSettings:modern};
let streamBody;
const adapter=createOpenAiCompatibleLlmAdapter({providerConfig:provider,runtimeContext:{fetchImpl:async(url,options)=>{
 streamBody=JSON.parse(options.body);
 return new Response('data: '+JSON.stringify({id:'r',choices:[{delta:{content:'Hello'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
}}});
for await(const event of adapter.stream({messages:[{role:'user',content:'Hello'}],temperature:0,maxOutputTokens:budget,responseFormat:{type:'json_object'}})){}
assert.equal(streamBody.model,'gpt-6-luna');assert.equal(streamBody.stream,true);assert.equal(streamBody.max_completion_tokens,1608);
assert.equal(streamBody.reasoning_effort,'none');assert.equal('max_tokens' in streamBody,false);assert.equal('temperature' in streamBody,false);assert.equal('untrusted_override' in streamBody,false);
assert.deepEqual(streamBody.response_format,{type:'json_object'});await adapter.close();
const configuration=resolveLlmConfiguration({llm:{...provider,parameters:[{key:'OPENAI_API_KEY',value:'test-only'}]}});
let regularBody;
await invokeAgentLlm(configuration,{messages:[],temperature:0.7,maxOutputTokens:777},async(url,options)=>{
 regularBody=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'Hello'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
});
assert.equal(regularBody.max_completion_tokens,777);assert.equal('max_tokens' in regularBody,false);assert.equal('temperature' in regularBody,false);
console.log('PASS legacy defaults, validated options, dynamic budget, streaming/utility payloads and ignored arbitrary fields');
