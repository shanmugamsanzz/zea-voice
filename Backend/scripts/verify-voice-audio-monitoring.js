import assert from 'node:assert/strict';
import { AudioPacer } from '../src/voice/audio/audio-pacer.js';
import { FramedAudioQueue } from '../src/voice/audio/framed-audio-queue.js';

const waitFor = async (predicate, message) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const schedulerQueue = new FramedAudioQueue({
  maxFrames: 20, maxBytes: 10_000, maxBufferedMs: 2_000,
});
for (let index = 0; index < 8; index += 1) {
  await schedulerQueue.enqueue({
    data: Buffer.alloc(160, index), durationMs: 20,
    generationId: 'sentence-1', playbackGroupId: 'turn-1', cancellationVersion: 0,
  });
}
let clock = 0;
const schedulerMetrics = [];
const schedulerPacer = new AudioPacer({
  queue: schedulerQueue,
  send: async () => ({ deliveryMs: 0, bufferedAmountAfter: 0 }),
  shouldSend: () => true,
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds + 20; },
  packetDurationMs: 80,
  preRollMs: 0,
  lowWaterMs: 0,
  deliveryLeadMs: 40,
  underrunThresholdMs: 10,
  onPlaybackMetric: (metric) => schedulerMetrics.push(metric),
});
schedulerPacer.start();
await schedulerPacer.drain();
assert.ok(schedulerMetrics.some((metric) => metric.type === 'playback_deadline_miss'),
  'Scheduler lateness must be distinguished from a real empty playback buffer');
assert.equal(schedulerMetrics.some((metric) => metric.type === 'underrun'), false,
  'Buffered scheduler lateness must not be reported as an audio underrun');
schedulerQueue.close();
await schedulerPacer.stop();

const transportQueue = new FramedAudioQueue({
  maxFrames: 10, maxBytes: 10_000, maxBufferedMs: 1_000,
});
await transportQueue.enqueue({
  data: Buffer.alloc(160), durationMs: 20,
  generationId: 'sentence-1', playbackGroupId: 'turn-2', cancellationVersion: 0,
});
const transportMetrics = [];
const transportPacer = new AudioPacer({
  queue: transportQueue,
  send: async () => ({
    deliveryMs: 55,
    bufferedAmountAfter: 300_000,
  }),
  shouldSend: () => true,
  packetDurationMs: 80,
  preRollMs: 0,
  lowWaterMs: 0,
  deliveryLeadMs: 160,
  websocketWarnMs: 40,
  websocketBufferWarnBytes: 262_144,
  onPlaybackMetric: (metric) => transportMetrics.push(metric),
});
transportPacer.start();
await waitFor(() => transportMetrics.some((metric) => metric.type === 'websocket_delivery'),
  'WebSocket delivery metric was not emitted');
const delivery = transportMetrics.find((metric) => metric.type === 'websocket_delivery');
assert.equal(delivery.deliveryMs, 55);
assert.equal(delivery.slow, true);
assert.equal(delivery.backpressured, true);
assert.equal(delivery.bufferedAmount, 300_000);
transportQueue.close();
await transportPacer.stop();

console.log(JSON.stringify({
  success: true,
  task: 'Accurate scheduler, underrun and WebSocket delivery monitoring',
}));
