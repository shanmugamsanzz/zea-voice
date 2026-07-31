import assert from 'node:assert/strict';
import { FramedAudioQueue } from '../src/voice/audio/framed-audio-queue.js';
import { AudioPacer } from '../src/voice/audio/audio-pacer.js';

const waitFor = async (predicate, message) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const queue = new FramedAudioQueue({ maxFrames: 10, maxBytes: 1000, maxBufferedMs: 1000 });
const sent = [];
let cancellationVersion = 0;
let releasePacing;
const pacer = new AudioPacer({
  queue,
  now: () => 0,
  shouldSend: (frame) => frame.cancellationVersion === cancellationVersion,
  packetDurationMs: 20,
  preRollMs: 0,
  lowWaterMs: 0,
  deliveryLeadMs: 0,
  send: async (frame) => sent.push(frame.data[0]),
  sleep: () => new Promise((resolve) => { releasePacing = resolve; }),
});
pacer.start();
await queue.enqueue({ data: Buffer.from([1]), durationMs: 20, cancellationVersion: 0 });
await waitFor(() => sent.length === 1, 'First audio frame was not sent');
await queue.enqueue({ data: Buffer.from([2]), durationMs: 20, cancellationVersion: 0 });
await waitFor(() => typeof releasePacing === 'function', 'Second frame was not held by pacing');

// Simulates barge-in after the pacer has already removed a frame from the queue.
cancellationVersion += 1;
queue.clear();
releasePacing();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(sent, [1], 'A stale in-flight audio frame was sent after interruption');

queue.close();
await pacer.stop();
console.log(JSON.stringify({ success: true, task: 'Interruption audio isolation' }));
