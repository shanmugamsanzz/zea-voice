import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './gpt-runner/run.js';
import { batchMain } from './gpt-runner/batch-run.js';
import { loadConfiguration, validateScenario } from './gpt-runner/config.js';
import { createConfiguredCaller } from './gpt-runner/caller.js';
import { runConversation } from './gpt-runner/conversation.js';
import { runBatch } from './gpt-runner/batch.js';
import { buildReport } from './gpt-runner/report.js';
const scenario={id:'release-check',language:'ta-IN',openingQuestion:'வணக்கம்',goals:['Information only.']};
const config={placeholder:false,callerConfigPath:'synthetic-local-config',language:'ta-IN',shareToken:'A'.repeat(43),maxDurationSeconds:30};
const capture=()=>{let out='';let err='';return{stdout:{write(v){out+=v;}},stderr:{write(v){err+=v;}},out:()=>out,err:()=>err};};
test('live CLI requires both permission flags and refuses mixed dry-run permissions',async()=>{
  let loads=0;let calls=0;
  for(const args of [
    ['--config','private.json','--live'],
    ['--config','private.json','--allow-session-records'],
    ['--config','private.json','--dry-run','--live','--allow-session-records'],
  ]){
    const io=capture();assert.equal(await main(args,{...io,load:async()=>{loads++;},execute:async()=>{calls++;}}),2);
    assert.ok(!io.err().includes('private.json'));
  }
  assert.equal(loads,0);assert.equal(calls,0);
  const io=capture();
  assert.equal(await main(['--config','synthetic.json','--live','--allow-session-records'],{...io,
    load:async()=>({config,scenario}),execute:async()=>{calls++;return{report:{liveTestVerified:false,generatedTurns:0,cleanup:'requested',failure:null}};}}),0);
  assert.equal(calls,1);assert.equal(JSON.parse(io.out()).liveTestVerified,false);
});
test('simulation cannot silently use a real session client',async()=>{
  await assert.rejects(runConversation({config,scenario,caller:{},mode:'simulation'}),{code:'SIMULATION_DEPENDENCIES'});
});
test('language fixtures validate independently; unsupported Hindi is policy coverage, not proof',async()=>{
  const folder=new URL('./gpt-runner/scenarios/',import.meta.url);
  for(const [file,language]of [['tamil-smoke.json','ta-IN'],['english-smoke.json','en-IN'],['hindi-policy-check.json','hi-IN']]){
    const raw=JSON.parse(await readFile(new URL(file,folder),'utf8'));
    assert.equal(validateScenario(raw,language).language,language);
  }
});
test('report expected-phrase absence is marked needs-review rather than a certified wrong answer',()=>{
  const report=buildReport({mode:'simulation',scenario,expectedFacts:['approved phrase'],transcripts:[{speaker:'agent',text:'other reply',sequenceNumber:1}]});
  assert.equal(report.findings[0].certainty,'needs-review');
  assert.equal(report.liveTestVerified,false);assert.match(report.answerAccuracy,/not certified/u);
});
test('batch captures per-job failures and refuses cancelled work',async()=>{
  const values=await runBatch([0,1,2],{concurrency:2,run:async value=>{if(value===1)throw new Error('synthetic-secret');return value;}});
  assert.equal(values[1].status,'failed');assert.ok(!JSON.stringify(values).includes('synthetic-secret'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(runBatch([1],{run:async()=>{},signal:controller.signal}),{code:'CANCELLED'});
});
test('batch dry-run checks local configs without invoking a live job',async()=>{
  const manifest=fileURLToPath(new URL('./gpt-runner/batch.example.json',import.meta.url));
  const io=capture();let invoked=0;
  assert.equal(await batchMain(['--manifest',manifest,'--dry-run'],{...io,invoke:async()=>{invoked++;}}),0);
  assert.equal(invoked,0);assert.equal(JSON.parse(io.out()).sessionsCreated,0);
});
test('missing caller keys are rejected before adapter import or network activity',async()=>{
  const example=fileURLToPath(new URL('./gpt-runner/caller.config.example.json',import.meta.url));
  await assert.rejects(createConfiguredCaller(scenario,example,{}),{code:'CALLER_CREDENTIALS'});
});
