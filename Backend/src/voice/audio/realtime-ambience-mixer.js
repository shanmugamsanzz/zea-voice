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
    this.format = options.format ?? PLIVO_MULAW_8K;
    this.frameDurationMs = options.frameDurationMs ?? this.format.frameDurationMs;
    this.frameBytes = audioFrameBytes(this.format, this.frameDurationMs);
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
    let deadline = this.now();
    while (!signal.aborted) {
      const speech = this.queue.tryDequeue();
      const output = this.#mix(speech);
      const waitMs = deadline - this.now();
      if (waitMs > 0) await this.sleep(waitMs, signal);
      if (signal.aborted) break;
      this.sendingSpeech = Boolean(speech);
      if (output) {
        await this.send({ data: output, durationMs: this.frameDurationMs, ambience: true });
        this.metrics.framesSent += 1;
        if (speech) this.metrics.speechFramesMixed += 1;
        else this.metrics.ambienceOnlyFrames += 1;
      }
      this.sendingSpeech = false;
      deadline = Math.max(deadline + this.frameDurationMs, this.now());
      this.#resolveDrains();
    }
  }

  drain() {
    if (this.queue.size === 0 && !this.sendingSpeech) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
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
