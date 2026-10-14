import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describePlivoHangupCause, plivoHangupOutcome } from '../src/telephony/plivo-webhook.service.js';

assert.equal(plivoHangupOutcome({
  HangupSource: 'Callee', HangupCauseName: 'Normal Hangup',
  HangupCauseCode: '4000', CallStatus: 'completed', Event: 'Hangup', BillDuration: '30',
}), 'completed');
for (const [cause, expected] of [
  ['Normal Hangup', 'completed'], ['Normal Clearing', 'completed'],
  ['User Busy', 'busy'], ['No Answer', 'no_answer'], ['Call Rejected', 'rejected'],
  ['Destination Unavailable', 'unavailable'], ['Canceled', 'canceled'],
  ['Network Failure', 'failed'], ['Abnormal Hangup', 'failed'], ['Unknown', 'failed'],
]) {
  assert.equal(plivoHangupOutcome({ HangupCauseName: cause, CallStatus: 'completed' }), expected, cause);
}
assert.equal(plivoHangupOutcome({ CallStatus: 'completed' }), 'completed');
assert.equal(plivoHangupOutcome({ CallStatus: 'failed' }), 'failed');
assert.equal(plivoHangupOutcome({}), 'failed');

assert.deepEqual(describePlivoHangupCause({
  HangupSource: 'Caller',
  HangupCauseName: 'Normal Clearing',
  HangupCauseCode: '16',
  CallStatus: 'completed',
  BillDuration: '48',
}), {
  hangupOrigin: 'caller',
  hangupSource: 'Caller',
  hangupCauseName: 'Normal Clearing',
  hangupCauseCode: '16',
  callStatus: 'completed',
  event: null,
  durationSeconds: 48,
});
assert.equal(describePlivoHangupCause({ HangupSource: 'Carrier' }).hangupOrigin, 'carrier');
assert.equal(describePlivoHangupCause({ HangupSource: 'Plivo' }).hangupOrigin, 'plivo');
assert.equal(describePlivoHangupCause({ HangupSource: 'Unspecified' }).hangupOrigin, 'unknown');

const serviceSource = await readFile(
  new URL('../src/telephony/plivo-webhook.service.js', import.meta.url), 'utf8',
);
assert.match(serviceSource, /stage:\s*'plivo\.hangup_cause'/u);
assert.match(serviceSource, /callId:\s*call\.id/u);
assert.match(serviceSource, /providerCallId/u);
assert.match(serviceSource, /describePlivoHangupCause\(input\.payload\)/u);
console.log(JSON.stringify({
  success: true,
  task: 'Structured Plivo hangup-cause logging',
  origins: ['caller', 'carrier', 'plivo', 'unknown'],
}));
