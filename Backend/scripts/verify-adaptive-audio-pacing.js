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

const queue = new FramedAudioQueue({ maxFrames: 20, maxBytes: 10_000, maxBufferedMs: 2_000 });
const sent = [];
const metrics = [];
const pacer = new AudioPacer({
  queue,
  send: async (packet) => sent.push(packet),
  shouldSend: () => true,
  packetDurationMs: 80,
  preRollMs: 120,
  preRollMaxWaitMs: 100,
  lowWaterMs: 60,
  deliveryLeadMs: 160,
  onPlaybackMetric: (metric) => metrics.push(metric),
});
pacer.start();

await queue.enqueue({
  data: Buffer.alloc(160, 1), durationMs: 20, generationId: 'sentence-1',
  playbackGroupId: 'turn-1', cancellationVersion: 0,
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(sent.length, 0, 'Playback must briefly pre-roll a thin initial stream');

for (let index = 0; index < 5; index += 1) {
  await queue.enqueue({
    data: Buffer.alloc(160, index + 2), durationMs: 20, generationId: 'sentence-1',
    playbackGroupId: 'turn-1', cancellationVersion: 0,
  });
}
await waitFor(() => sent.length === 1, 'Pre-rolled audio packet was not delivered');
assert.equal(sent[0].durationMs, 80, 'Four 20 ms frames must be delivered as one stable 80 ms packet');
assert.equal(sent[0].data.length, 640);
assert.equal(sent[0].packetFrameCount, 4);
assert.ok(metrics.some((metric) => metric.type === 'playback_pre_roll'));

await pacer.drain();
assert.equal(sent.reduce((total, packet) => total + packet.durationMs, 0), 120,
  'Packet batching must preserve the complete audio duration');

// If Plivo has already exhausted its remote buffer, a recovered later
// sentence must be sent immediately. Waiting for another pre-roll at this
// point would only enlarge the audible sentence gap.
await new Promise((resolve) => setTimeout(resolve, 150));
const recoveredAt = performance.now();
await queue.enqueue({
  data: Buffer.alloc(640, 9), durationMs: 80, generationId: 'sentence-2',
  playbackGroupId: 'turn-1', cancellationVersion: 0,
});
await waitFor(() => sent.length === 3, 'Recovered sentence packet was not delivered');
assert.ok(performance.now() - recoveredAt < 80,
  'Plivo pacing added a new pre-roll delay after playback had already underrun');

queue.close();
await pacer.stop();
console.log(JSON.stringify({ success: true, task: 'Adaptive buffered audio pacing' }));
