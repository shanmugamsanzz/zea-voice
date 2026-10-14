import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionClient, mediaUrl, validateSession } from './gpt-runner/session-client.js';
import { MediaClient } from './gpt-runner/media-client.js';
import { AutomatedCaller } from './gpt-runner/caller.js';
import { runConversation } from './gpt-runner/conversation.js';
import { runBatch } from './gpt-runner/batch.js';
import { buildReport, writeReport } from './gpt-runner/report.js';
import { silence, toMuLaw, decodePayload, pcmWavFromMuLaw } from './gpt-runner/audio.js';
import { RunnerError, bounded } from './gpt-runner/errors.js';

const id = '10000000-0000-4000-8000-000000000001';
const agentId = '10000000-0000-4000-8000-000000000002';
const session = { callId:id,testCallId:id,agentId,tenantId:id,workspaceId:id,
  token:'synthetic.payload',mediaPath:'/voice/browser-test/media',protocol:'zea.browser-voice.v1',
  expiresAt:new Date(Date.now()+60000).toISOString(),
  inputFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1},
  outputFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1} };
const config = { apiBaseUrl:'http://127.0.0.1/api',shareToken:'A'.repeat(43),maxTurns:2,maxDurationSeconds:10 };
const scenario = {id:'local-protocol',language:'ta-IN',openingQuestion:'வணக்கம்',goals:['Ask information only.']};

async function localTarget({ ready = true, responder = true } = {}) {
  let creations=0; let deletions=0; let requests=0; let sequence=0;
  const received=[]; let claimed=false; const sockets=new Set();
  const server=createServer(async (req,res)=>{
    requests++;
    if(req.method==='GET') res.end(JSON.stringify({success:true,data:{agent:{id:agentId,status:'active',agentUsage:'inbound'}}}));
    else if(req.method==='POST') {creations++;res.end(JSON.stringify({success:true,data:session}));}
    else {deletions++;res.end(JSON.stringify({success:true,data:{status:'completed'}}));}
  });
  const wss=new WebSocketServer({noServer:true,handleProtocols: p=>p.has(session.protocol)?session.protocol:false});
  server.on('upgrade',(req,socket,head)=>{
    if(!req.url.startsWith('/api/voice/browser-test/media?')||claimed){socket.end('HTTP/1.1 409 Conflict\r\n\r\n');return;}
    claimed=true;wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection', ws=>{
    sockets.add(ws);ws.on('close',()=>sockets.delete(ws));
    if(ready) ws.send(JSON.stringify({event:'ready',callId:id,streamId:'local',mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000}}));
    let speechBytes=0;let responding=false;let turn=0;
    ws.on('message',data=>{
      const event=JSON.parse(data);received.push(event);
      if(event.event==='stop'){ws.close();return;}
      if(event.event==='media'&&responder){
        const bytes=Buffer.from(event.media.payload,'base64');
        if(bytes.some(b=>b!==255))speechBytes+=bytes.length;
        if(speechBytes>=1600&&!responding){
          responding=true;speechBytes=0;turn++;
          for(const speaker of ['user','agent'])ws.send(JSON.stringify({event:'diagnostic',diagnostic:{
            type:'transcript',sequenceNumber:++sequence,speaker,text:speaker==='user'?'recognized caller':'reply '+turn,offsetMs:turn*200}}));
          ws.send(JSON.stringify({event:'audio',media:{contentType:'audio/x-mulaw',sampleRate:8000,payload:Buffer.alloc(160,255).toString('base64')}}));
          ws.send(JSON.stringify({event:'checkpoint',name:'turn-'+turn}));
        }
      }
      if(event.event==='playedStream')responding=false;
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/api';
  return {config:{...config,apiBaseUrl:base},received,wss,sockets,
    counts:()=>({creations,deletions,requests}),
    close:async()=>{for(const ws of sockets)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
  };
}
test('raw codecs validate format, preserve silence and produce valid PCM WAV',()=>{
  assert.equal(silence().length,160);assert.ok(silence().every(b=>b===255));
  const pcm=Buffer.alloc(320);pcm.writeInt16LE(10000,0);
  const ulaw=toMuLaw(pcm,{encoding:'pcm_s16le',sampleRate:8000,channels:1});
  assert.equal(ulaw.length,160);assert.equal(ulaw[1],255);
  assert.throws(()=>toMuLaw(Buffer.alloc(3),{encoding:'pcm_s16le',sampleRate:8000,channels:1}),/PCM/u);
  assert.throws(()=>decodePayload('invalid!'),/payload/u);
  const wav=pcmWavFromMuLaw(ulaw);assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),8000);
});
test('session client preserves prefix, validates identity and sends no duplicate creation',async()=>{
  const calls=[];
  const client=new SessionClient(config,{fetchImpl:async(url,init)=>{
    calls.push({url,init});
    return new Response(JSON.stringify({success:true,data:init.method==='GET'?{agent:{id:agentId,status:'active',agentUsage:'inbound'}}:session}));
  }});
  const details=await client.lookup();await client.create(details);await client.end(id);
  assert.deepEqual(calls.map(c=>c.init.method),['GET','POST','DELETE']);
  assert.ok(calls.every(c=>c.url.startsWith(config.apiBaseUrl+'/public/')));
  assert.ok(calls.every(c=>c.init.redirect==='error'));
  assert.match(mediaUrl(config,session),/\/api\/voice\/browser-test\/media\?/u);
  assert.throws(()=>validateSession({...session,agentId:id},agentId),/contract/u);
});
test('HTTP timeout, redirect errors and cancellation omit private details',async()=>{
  const client=new SessionClient(config,{timeoutMs:15,fetchImpl:async()=>new Promise(()=>{})});
  await assert.rejects(client.lookup(),{code:'TIMEOUT'});
  const privateClient=new SessionClient(config,{fetchImpl:async()=>{throw new Error(config.shareToken);}});
  await assert.rejects(privateClient.lookup(),error=>error.code==='HTTP_UNAVAILABLE'&&!error.message.includes(config.shareToken));
  const controller=new AbortController();controller.abort();
  await assert.rejects(client.lookup(controller.signal),{code:'CANCELLED'});
});
test('local simulated conversation receives paced audio, adaptive follow-ups and cleanup',async()=>{
  const target=await localTarget();let generations=0;
  const caller=new AutomatedCaller(scenario,{
    generate:async request=>{generations++;assert.ok(request.conversation.some(l=>l.text==='reply 1'));return{done:false,question:'What about its price?'};},
    synthesize:async()=>({audio:Buffer.alloc(1600,128),format:{encoding:'mulaw',sampleRate:8000,channels:1}})
  });
  try{
    const result=await runConversation({config:target.config,scenario,caller,mode:'simulation',
      dependencies:{agentInitiates:false,sessionClient:new SessionClient(target.config),mediaFactory:(cfg,session)=>new MediaClient(cfg,session)}});
    assert.equal(result.report.failure,null);
    assert.equal(result.report.mode,'simulation');assert.equal(result.report.liveTestVerified,false);
    assert.equal(generations,1);assert.equal(result.report.generatedTurns,2);
    assert.equal(result.report.transcripts.filter(l=>l.speaker==='agent').length,2);
    assert.equal(target.counts().creations,1);assert.equal(target.counts().deletions,1);
    assert.equal(target.received.filter(e=>e.event==='playedStream').length,2);
    const frames=target.received.filter(e=>e.event==='media');
    assert.ok(frames.length>=20);assert.ok(frames.every(e=>Buffer.from(e.media.payload,'base64').length===160));
    assert.ok(result.incoming.length);assert.ok(result.outgoing.length);
  }finally{await target.close();}
});
test('live database-record permission is enforced before any client operation',async()=>{
  let requests=0;
  await assert.rejects(runConversation({config,scenario,caller:{},dependencies:{sessionClient:{lookup(){requests++;}}}}),
    {code:'DATABASE_WRITE_NOT_AUTHORIZED'});
  assert.equal(requests,0);
});
test('readiness timeout closes socket; no external services or database involved',async()=>{
  const target=await localTarget({ready:false});const media=new MediaClient(target.config,session,{startupMs:30,closeMs:100});
  try{await assert.rejects(media.connect(),{code:'MEDIA_START_TIMEOUT'});await media.close();assert.equal(media.state,'closed');}
  finally{await target.close();}
});
test('clear-audio cancels checkpoint and acknowledges clearing',async()=>{
  const target=await localTarget({responder:false});const media=new MediaClient(target.config,session,{closeMs:100});
  try{
    await media.connect();
    const socket=[...target.sockets][0];
    socket.send(JSON.stringify({event:'audio',media:{contentType:'audio/x-mulaw',sampleRate:8000,payload:Buffer.alloc(1600,255).toString('base64')}}));
    socket.send(JSON.stringify({event:'checkpoint',name:'stale'}));
    const interrupted=once(media,'interruption');
    socket.send(JSON.stringify({event:'clearAudio'}));await interrupted;
    // A new checkpoint after clear provides an observable boundary without a fixed delay.
    const played=once(media,'playbackComplete');socket.send(JSON.stringify({event:'checkpoint',name:'fresh'}));await played;
    await media.close();
    assert.ok(target.received.some(e=>e.event==='clearedAudio'));
    assert.ok(!target.received.some(e=>e.event==='playedStream'&&e.name==='stale'));
  }finally{await media.close();await target.close();}
});
test('invalid target audio fails safely and terminates transport',async()=>{
  const target=await localTarget({responder:false});const media=new MediaClient(target.config,session,{closeMs:100});
  try{await media.connect();const failed=once(media,'failure');
    [...target.sockets][0].send(JSON.stringify({event:'audio',media:{contentType:'audio/mp3',sampleRate:8000,payload:'AAAA'}}));
    const [error]=await failed;assert.equal(error.code,'MEDIA_FORMAT');await media.close();
  }finally{await media.close();await target.close();}
});
test('caller rejects malformed decisions and cancels a stalled provider',async()=>{
  const caller=new AutomatedCaller(scenario,{timeoutMs:15,generate:async()=>({done:'no',question:'bad'}),
    synthesize:async()=>({audio:Buffer.alloc(160,128),format:{encoding:'mulaw',sampleRate:8000,channels:1}})});
  await caller.audio('question');await assert.rejects(caller.next([]),{code:'CALLER_DECISION'});
  const stalled=new AutomatedCaller(scenario,{timeoutMs:15,generate:async()=>{},synthesize:async()=>new Promise(()=>{})});
  await assert.rejects(stalled.audio('question'),{code:'TIMEOUT'});
});
test('reports redact tokens and distinguish simulation; tool and accuracy stay unverified',async()=>{
  const secret='synthetic-token-to-redact';
  const report=buildReport({mode:'simulation',scenario,transcripts:[{speaker:'agent',text:secret,sequenceNumber:1,offsetMs:0}],secrets:[secret]});
  assert.ok(!JSON.stringify(report).includes(secret));assert.equal(report.liveTestVerified,false);
  assert.match(report.toolVerification,/unverified/u);assert.match(report.answerAccuracy,/not certified/u);
  const directory=await mkdtemp(path.join(tmpdir(),'zea-runner-report-'));
  try{const output=await writeReport(directory,report);const stored=JSON.parse(await readFile(path.join(output,'report.json'),'utf8'));
    assert.equal(stored.mode,'simulation');
    await assert.rejects(readFile(path.join(output,'agent.wav')), {code:'ENOENT'});
  }finally{const rel=path.relative(tmpdir(),directory);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&path.basename(directory).startsWith('zea-runner-report-'));await rm(directory,{recursive:true,force:true});}
});
test('batch caps parallel workers and preserves per-job results',async()=>{
  let active=0;let peak=0;
  const results=await runBatch(Array.from({length:5},(_,id)=>id),{concurrency:2,run:async id=>{
    active++;peak=Math.max(peak,active);await bounded(async()=>id,{timeoutMs:100});active--;return id;
  }});
  assert.equal(results.length,5);assert.ok(peak<=2);assert.ok(results.every(r=>r.status==='completed'));
  await assert.rejects(runBatch(Array(11).fill(0),{run:async()=>{}}),{code:'BATCH_CONFIG'});
});

test('runtime playback state completes a turn without a socket checkpoint', async () => {
  const target = await localTarget({responder:false});
  const media = new MediaClient(target.config, session, {closeMs:100});
  try {
    await media.connect();
    const waiting = media.waitForAgentTurn(0, undefined, 1000);
    const socket = [...target.sockets][0];
    socket.send(JSON.stringify({event:'diagnostic',diagnostic:{type:'transcript',speaker:'agent',sequenceNumber:1,text:'completed reply',offsetMs:10}}));
    socket.send(JSON.stringify({event:'audio',media:{contentType:'audio/x-mulaw',sampleRate:8000,payload:Buffer.alloc(160,255).toString('base64')}}));
    socket.send(JSON.stringify({event:'diagnostic',diagnostic:{type:'state',previous:'speaking',current:'listening',reason:'playback_completed'}}));
    const lines = await waiting;
    assert.equal(lines[0].text,'completed reply');
    assert.equal(media.runtimeState,'listening');
    assert.equal(media.lastCompletedSequence,1);
  } finally { await media.close(); await target.close(); }
});
