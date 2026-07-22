import assert from 'node:assert/strict';
import { audioDurationMs, PLIVO_MULAW_8K, resolveModelAudioFormat } from '../src/voice/audio/audio-format.js';
import { decodeAudio, encodeAudio, normalizeMono } from '../src/voice/audio/codec.js';
import { resamplePcm16 } from '../src/voice/audio/resampler.js';
import { FramedAudioQueue } from '../src/voice/audio/framed-audio-queue.js';
import { ProviderIndependentAudioEngine } from '../src/voice/audio/audio-engine.js';

const dynamicProvider = {
  providerId: 'provider-from-database',
  modelId: 'model-from-database',
  modelKey: 'dynamic-model',
  modelCapabilities: {
    audio: {
      input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
      output: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
    },
  },
};

const inputFormat = resolveModelAudioFormat(dynamicProvider, 'input');
assert.equal(inputFormat.encoding, 'pcm_s16le');
assert.equal(inputFormat.sampleRate, 16000);
assert.throws(
  () => resolveModelAudioFormat({ modelKey: 'undeclared' }, 'input'),
  (error) => error.code === 'VOICE_AUDIO_CAPABILITY_MISSING',
);

const pcm = Int16Array.from([-30000, -1000, 0, 1000, 30000]);
const mulaw = encodeAudio(pcm, PLIVO_MULAW_8K);
const decodedMulaw = decodeAudio(mulaw, PLIVO_MULAW_8K);
assert.equal(mulaw.length, pcm.length);
assert.equal(decodedMulaw.length, pcm.length);
assert.ok(Math.abs(decodedMulaw[2]) < 10);
assert.ok(Math.abs(decodedMulaw[4] - pcm[4]) < 1000);

const pcmBuffer = encodeAudio(pcm, inputFormat);
assert.deepEqual(decodeAudio(pcmBuffer, inputFormat), pcm);
assert.deepEqual(normalizeMono(Int16Array.from([1000, 3000, -2000, 2000]), 2), Int16Array.from([2000, 0]));

const upsampled = resamplePcm16(Int16Array.from({ length: 160 }, (_, index) => index * 10), 8000, 16000);
assert.equal(upsampled.length, 320);

const queue = new FramedAudioQueue({ maxFrames: 1, maxBytes: 100, maxBufferedMs: 100 });
await queue.enqueue({ data: Buffer.alloc(10), durationMs: 20, generationId: 'first' });
let secondWritten = false;
const secondWrite = queue.enqueue({ data: Buffer.alloc(10), durationMs: 20, generationId: 'second' })
  .then(() => { secondWritten = true; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(secondWritten, false, 'full queue must apply backpressure');
assert.equal((await queue.dequeue()).generationId, 'first');
await secondWrite;
assert.equal(secondWritten, true);
assert.equal(queue.cancelGeneration('second'), 1);
queue.close();

const sent = [];
let clearCount = 0;
let clock = 0;
const mediaSession = {
  started: true,
  closed: false,
  sendAudio(data) { sent.push(data); },
  clearAudio() { clearCount += 1; },
};
const runtimeProfile = { providers: { stt: dynamicProvider, tts: dynamicProvider } };
const engine = new ProviderIndependentAudioEngine({
  runtimeProfile,
  mediaSession,
  now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
}).start();

const inboundMuLaw = encodeAudio(Int16Array.from({ length: 160 }, (_, index) => Math.sin(index / 10) * 10000), PLIVO_MULAW_8K);
await engine.enqueueInbound(inboundMuLaw);
const inboundFrame = await engine.readInbound();
assert.equal(inboundFrame.data.length, 636, 'streaming 8 kHz to 16 kHz conversion retains boundary state');
assert.ok(Math.abs(audioDurationMs(inboundFrame.data.length, inputFormat) - 19.875) < 0.001);

const generationId = engine.beginOutputGeneration('response-1');
const synthesized = encodeAudio(Int16Array.from({ length: 320 }, (_, index) => Math.sin(index / 8) * 8000), inputFormat);
assert.equal(await engine.enqueueSynthesized(synthesized, generationId), true);
await engine.flushSynthesized(generationId);
await engine.drainOutput();
assert.equal(sent.length, 1);
assert.equal(sent[0].length, 160, 'Plivo receives paced 20 ms mu-law frames');

engine.beginOutputGeneration('response-2');
engine.cancelStaleAudio('barge-in');
assert.equal(clearCount, 1, 'barge-in clears already buffered Plivo audio');
await engine.close();

console.log('Voice task 7 verification passed: dynamic DSP, mono PCM, resampling, backpressure, pacing and cancellation are working.');
