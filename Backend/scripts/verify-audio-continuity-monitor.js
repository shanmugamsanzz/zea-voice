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

let clock = 0;
const metrics = [];
const queue = new FramedAudioQueue({ maxFrames: 10, maxBytes: 1000, maxBufferedMs: 1000 });
await queue.enqueue({
  data: Buffer.from([1]), durationMs: 20, generationId: 'sentence-1',
  playbackGroupId: 'turn-1', cancellationVersion: 0,
});
await queue.enqueue({
  data: Buffer.from([2]), durationMs: 20, generationId: 'sentence-2',
  playbackGroupId: 'turn-1', cancellationVersion: 0,
});
const pacer = new AudioPacer({
  queue,
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds + 60; },
  shouldSend: () => true,
  underrunThresholdMs: 40,
  onPlaybackMetric: (metric) => metrics.push(metric),
  send: async () => {},
});
pacer.start();
await waitFor(() => metrics.length === 1, 'Playback underrun was not measured');
assert.equal(metrics[0].type, 'underrun');
assert.equal(metrics[0].sentenceBoundary, true);
assert.equal(metrics[0].gapMs, 60);
assert.equal(metrics[0].playbackGroupId, 'turn-1');
queue.close();
await pacer.stop();

console.log(JSON.stringify({ success: true, task: 'Turn-scoped audio continuity monitoring' }));
