import assert from 'node:assert/strict';
import { CallerTurnWait } from '../src/voice/interruption/caller-turn-wait.js';
import { CustomerUtteranceBuffer } from '../src/voice/interruption/customer-utterance-buffer.js';
import { normalizeInteractionSettings, resolveInteractionConfiguration } from '../src/voice/interaction/interaction-config.js';

assert.equal(resolveInteractionConfiguration({}).callerTurnWaitMs, 0);
for (const wait of [0, 600, 1000, 1500, 5000]) {
  assert.equal(normalizeInteractionSettings({ callerTurnWaitMs: wait }).callerTurnWaitMs, wait);
}
for (const value of [-1, 5001, 1.5, 'invalid']) {
  assert.throws(() => normalizeInteractionSettings({ callerTurnWaitMs: value }),
    (error) => error.field === 'callerTurnWaitMs');
}
let now = 0;
let id = 0;
const timers = new Map();
const callbacks = [];
const wait = new CallerTurnWait({
  setTimer: (callback, delay) => { timers.set(++id, { callback, due: now + delay }); callbacks.push(callback); return id; },
  clearTimer: (key) => timers.delete(key),
});
const advance = (ms) => {
  now += ms;
  for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); timer.callback(); }
};
const buffer = new CustomerUtteranceBuffer();
const completed = [];
const schedule = () => wait.schedule(1500, () => {
  if (buffer.markFinalProcessed()) completed.push(buffer.text);
});
buffer.start();
buffer.observeFinal('I want an appointment');
buffer.markSpeechEnded();
schedule();
advance(1000);
assert.deepEqual(completed, []);
assert.equal(wait.cancel(), true);
buffer.resumeSpeech();
buffer.observePartial('tomorrow');
buffer.observeFinal('tomorrow afternoon');
buffer.markSpeechEnded();
schedule();
callbacks[0](); // A canceled callback racing with new speech cannot dispatch.
assert.deepEqual(completed, []);
advance(1499);
assert.deepEqual(completed, []);
advance(1);
assert.deepEqual(completed, ['I want an appointment tomorrow afternoon']);
assert.equal(wait.pending, false);
// A later cumulative final retains overlapping words exactly once.
buffer.start(); buffer.observeFinal('My number is'); buffer.markSpeechEnded(); schedule();
wait.cancel(); buffer.resumeSpeech();
buffer.observeFinal('My number is 12345'); buffer.markSpeechEnded(); schedule();
advance(1500);
assert.equal(completed.at(-1), 'My number is 12345');
schedule(); wait.cancel(); advance(5000); // Cleanup on hangup cancels dispatch.
assert.equal(completed.length, 2);
console.log('Caller wait presets, bounds, thinking pauses, stale timers, fragment merging and hangup cleanup passed.');
