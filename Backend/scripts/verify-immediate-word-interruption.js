import assert from 'node:assert/strict';
import {resolveInterruptionConfiguration} from '../src/voice/interruption/interruption-config.js';
import {InterruptionCandidateManager} from '../src/voice/interruption/interruption-candidate-manager.js';
import {CustomerUtteranceBuffer} from '../src/voice/interruption/customer-utterance-buffer.js';
const make=(settings={})=>{
 let now=0,timer;const confirmations=[];
 const m=new InterruptionCandidateManager({configuration:resolveInterruptionConfiguration({speechConfirmationDelayMs:1500,minimumMeaningfulWords:3,...settings}),now:()=>now,setTimer:fn=>{timer=fn;return {unref(){}};},clearTimer:()=>{},onConfirm:x=>confirmations.push(x)});
 return {m,confirmations,expire(){now=2000;timer?.();}};
};
for(const word of ['doctor','sollunga','\u0ba8\u0bbe\u0bb3\u0bc8']){
 const c=make();c.m.start();assert.equal(c.m.observeTranscript(word).confirmed,true);assert.equal(c.confirmations[0].elapsedMs,0);assert.equal(c.confirmations[0].confirmedBy,'first_recognized_word');
 c.m.observeTranscript(word+' please');c.expire();assert.equal(c.confirmations.length,1);
 c.m.reset();c.m.observeTranscript(word);assert.equal(c.confirmations.length,2);
}
for(const noise of ['', '  ', '...', '!!!']){const c=make();c.m.start();c.m.observeTranscript(noise);c.expire();assert.equal(c.confirmations.length,0);}
const off=make({timeBasedInterruptionEnabled:false});off.m.observeTranscript('stop now');off.expire();assert.equal(off.confirmations.length,0);
const ack=make({acknowledgementPhrases:['okay']});assert.equal(ack.m.observeTranscript('okay').confirmed,false);assert.equal(ack.m.observeTranscript('okay doctor').confirmed,true);
const legacy=make({immediateWordInterruption:false});assert.equal(legacy.m.observeTranscript('one two three').confirmed,false);legacy.expire();assert.equal(legacy.confirmations.length,1);
const buffer=new CustomerUtteranceBuffer();buffer.start();buffer.observePartial('doctor');assert.equal(buffer.ready,false);buffer.observeFinal('doctor name please');assert.equal(buffer.ready,false);buffer.markSpeechEnded();assert.equal(buffer.ready,true);
console.log('PASS immediate-word interruption: Tamil/Tanglish/English, no sound-only stop, toggle off, continue phrases, repeat cancellation, legacy mode and no premature turn dispatch');
