import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {resolveCallCheckResponse,validateCallCheckResponses,ongoingCallInstruction} from '../src/voice/interaction/call-check-language.js';
const settings={callCheckResponse:'Legacy Tamil',callCheckResponses:{en:'Yes, I am here. Please go ahead.',ta:'Irukken nga, sollunga.'}};
assert.equal(resolveCallCheckResponse(settings,'en','Tamil (India)'),settings.callCheckResponses.en);
assert.equal(resolveCallCheckResponse(settings,'ta','Tamil (India)'),settings.callCheckResponses.ta);
assert.equal(resolveCallCheckResponse({callCheckResponse:'Legacy Tamil'},'ta','Tamil (India)'),'Legacy Tamil');
assert.equal(resolveCallCheckResponse({callCheckResponse:'Legacy Tamil'},'en','Tamil (India)'),'');
assert.equal(resolveCallCheckResponse({callCheckResponse:'Legacy Tamil'},undefined,'Tamil (India)'),'Legacy Tamil');
assert.equal(resolveCallCheckResponse(settings,'hi','Tamil (India)'),'');
validateCallCheckResponses(settings);
assert.throws(()=>validateCallCheckResponses({callCheckResponses:{English:'bad key'}}));
assert.throws(()=>validateCallCheckResponses({callCheckResponses:{en:'x'.repeat(501)}}));
assert.throws(()=>validateCallCheckResponses({callCheckResponses:[]}));
assert.equal(ongoingCallInstruction(), '');
for(const state of [{openingStarted:true},{openingDelivered:true},{conversationStarted:true}]) {
 assert.match(ongoingCallInstruction(state),/Do not restart your introduction/);
 assert.match(ongoingCallInstruction(state),/active response language/);
 assert.match(ongoingCallInstruction(state),/does not prohibit asking consent/);
}
const source=await readFile(new URL('../src/voice/realtime-conversation-orchestrator.js',import.meta.url),'utf8');
assert.match(source,/mainPrompt: ongoingCallInstruction/);
assert.match(source,/this.openingStarted = true/);
assert.match(source,/if \(welcomePlayed\) this.openingDelivered = true/);
assert.match(source,/const callCheckResponse = resolveCallCheckResponse/);
console.log('PASS persistent opening states, localized call checks, default compatibility, missing-translation LLM fallback and settings bounds');
