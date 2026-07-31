import { decodeAudio, encodeAudio } from './codec.js';
import { PLIVO_MULAW_8K, audioFrameBytes } from './audio-format.js';

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => done(signal.reason ?? new Error('Ambience mixer stopped'));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class RealtimeAmbienceMixer {
  constructor(options) {
    if (!options?.queue || typeof options.send !== 'function' || !Buffer.isBuffer(options.ambienceAudio)) {
      throw new TypeError('Realtime ambience mixer requires a speech queue, sender and normalized ambience audio');
    }
    this.queue = options.queue;
    this.send = options.send;
    this.shouldSendSpeech = options.shouldSend ?? (() => true);
    this.onPlaybackMetric = options.onPlaybackMetric ?? (() => {});
    this.underrunThresholdMs = options.underrunThresholdMs ?? 40;
    this.format = options.format ?? PLIVO_MULAW_8K;
    this.frameDurationMs = options.frameDurationMs ?? this.format.frameDurationMs;
    this.frameBytes = audioFrameBytes(this.format, this.frameDurationMs);
    this.packetDurationMs = options.packetDurationMs ?? 80;
    this.packetFrameCount = Math.max(1, Math.ceil(this.packetDurationMs / this.frameDurationMs));
    this.deliveryLeadMs = options.deliveryLeadMs ?? 160;
    this.websocketWarnMs = options.websocketWarnMs ?? 40;
    this.websocketBufferWarnBytes = options.websocketBufferWarnBytes ?? 262_144;
    this.ambienceSamples = decodeAudio(options.ambienceAudio, this.format);
    if (!this.ambienceSamples.length) throw new TypeError('Normalized ambience audio is empty');
    this.listeningGain = Math.max(0, Math.min(1, Number(options.listeningVolumePercent ?? 10) / 100));
    this.speakingGain = Math.max(0, Math.min(1, Number(options.speakingVolumePercent ?? 5) / 100));
    this.continueDuringSilence = options.continueDuringSilence !== false;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? delay;
    this.position = 0;
    this.callerSpeaking = false;
    this.running = false;
    this.sendingSpeech = false;
    this.drainWaiters = [];
    this.metrics = { framesSent: 0, speechFramesMixed: 0, ambienceOnlyFrames: 0 };
    this.lastSpeechFrame = null;
    this.remotePlaybackEndAt = 0;
  }

  setCallerSpeaking(active) {
    this.callerSpeaking = Boolean(active);
  }

  #ambientFrame() {
    const result = new Int16Array(this.frameBytes);
    for (let index = 0; index < result.length; index += 1) {
      result[index] = this.ambienceSamples[this.position];
      this.position = (this.position + 1) % this.ambienceSamples.length;
    }
    return result;
  }

  #mix(speechFrame) {
    const speech = speechFrame ? decodeAudio(speechFrame.data, this.format) : null;
    const ambience = this.#ambientFrame();
    const gain = speech ? this.speakingGain : this.listeningGain;
    if (!speech && !this.callerSpeaking && !this.continueDuringSilence) return null;
    const mixed = new Int16Array(ambience.length);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = clamp16((speech?.[index] ?? 0) + ambience[index] * gain);
    }
    return encodeAudio(mixed, this.format);
  }

  start() {
    if (this.running) return this.runPromise;
    this.running = true;
    this.controller = new AbortController();
    this.runPromise = this.#run(this.controller.signal).catch((error) => {
      if (!this.controller.signal.aborted) this.onError(error);
    }).finally(() => {
      this.running = false;
      this.sendingSpeech = false;
      this.#resolveDrains();
    });
    return this.runPromise;
  }

  async #run(signal) {
    while (!signal.aborted) {
      const outputs = [];
      const speechFrames = [];
      for (let index = 0; index < this.packetFrameCount; index += 1) {
        let speech = this.queue.tryDequeue();
        if (speech && !this.shouldSendSpeech(speech)) speech = null;
        const output = this.#mix(speech);
        if (!output) break;
        outputs.push(output);
        if (speech) speechFrames.push(speech);
      }
      if (!outputs.length) {
        await this.sleep(this.frameDurationMs, signal);
        continue;
      }
      const packetDurationMs = outputs.length * this.frameDurationMs;
      const beforePacing = this.now();
      const remoteBufferedMs = Math.max(0, this.remotePlaybackEndAt - beforePacing);
      const waitMs = Math.max(0, remoteBufferedMs - this.deliveryLeadMs);
      if (waitMs > 0) await this.sleep(waitMs, signal);
      if (signal.aborted) break;
      if (speechFrames.some((speech) => !this.shouldSendSpeech(speech))) continue;
      this.sendingSpeech = speechFrames.length > 0;
      const sendingAt = this.now();
      const firstSpeech = speechFrames[0];
      const lastSpeech = speechFrames.at(-1);
      if (firstSpeech && this.lastSpeechFrame?.playbackGroupId
          && this.lastSpeechFrame.playbackGroupId === firstSpeech.playbackGroupId) {
          const gapMs = Math.max(0,
            sendingAt - (this.lastSpeechFrame.sentAt + this.lastSpeechFrame.durationMs));
          const sentenceBoundary = this.lastSpeechFrame.generationId !== firstSpeech.generationId;
          if (sentenceBoundary || gapMs >= this.underrunThresholdMs) {
            this.onPlaybackMetric({
              type: gapMs >= this.underrunThresholdMs ? 'underrun' : 'sentence_boundary',
              gapMs,
              sentenceBoundary,
              playbackGroupId: firstSpeech.playbackGroupId,
              fromGenerationId: this.lastSpeechFrame.generationId,
              toGenerationId: firstSpeech.generationId,
              bufferedAudioMs: this.queue.bufferedMs,
            });
          }
      }
      const deliveryStartedAt = this.now();
      const transport = await this.send({
        data: outputs.length === 1 ? outputs[0] : Buffer.concat(outputs),
        durationMs: packetDurationMs,
        ambience: true,
        packetFrameCount: outputs.length,
      });
      const deliveryMs = Math.max(0, Number(
        transport?.deliveryMs ?? (this.now() - deliveryStartedAt),
      ));
      const bufferedAmount = Math.max(0, Number(
        transport?.bufferedAmountAfter ?? transport?.bufferedAmountBefore ?? 0,
      ));
      this.onPlaybackMetric({
        type: 'websocket_delivery',
        deliveryMs,
        bufferedAmount,
        slow: deliveryMs >= this.websocketWarnMs,
        backpressured: bufferedAmount >= this.websocketBufferWarnBytes,
        packetDurationMs,
        packetBytes: outputs.reduce((total, output) => total + output.length, 0),
        packetFrameCount: outputs.length,
        ambience: true,
      });
      this.metrics.framesSent += outputs.length;
      this.metrics.speechFramesMixed += speechFrames.length;
      this.metrics.ambienceOnlyFrames += outputs.length - speechFrames.length;
      if (lastSpeech) this.lastSpeechFrame = { ...lastSpeech, sentAt: sendingAt };
      this.sendingSpeech = false;
      this.remotePlaybackEndAt = Math.max(this.remotePlaybackEndAt, sendingAt) + packetDurationMs;
      this.#resolveDrains();
    }
  }

  drain() {
    if (this.queue.size === 0 && !this.sendingSpeech) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  resetPlaybackTimeline() {
    this.remotePlaybackEndAt = 0;
    this.lastSpeechFrame = null;
  }

  #resolveDrains() {
    if (this.queue.size || this.sendingSpeech) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  async stop() {
    this.controller?.abort(new Error('Ambience mixer stopped'));
    await this.runPromise;
  }

  snapshot() { return { ...this.metrics, active: this.running }; }
}
