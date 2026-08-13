import assert from 'node:assert/strict';
import { sttEventPolicy } from '../src/voice/interaction/stt-event-policy.js';

const partial = sttEventPolicy('partial_transcript');
assert.equal(partial.bufferTranscript, true);
assert.equal(partial.allowBargeIn, true);
assert.equal(partial.processCallerTurn, false);

const final = sttEventPolicy('final_transcript');
assert.equal(final.bufferTranscript, true);
assert.equal(final.allowBargeIn, true);
assert.equal(final.processCallerTurn, true);

for (const type of ['speech_started', 'speech_ended', 'usage', 'error', '']) {
  assert.equal(sttEventPolicy(type).processCallerTurn, false);
}

console.log('Partial STT is barge-in/buffering only; finalized STT is the sole caller-turn trigger.');
