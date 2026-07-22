import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errors.js';
import { audioDurationMs, audioFrameBytes, PLIVO_MULAW_8K, resolveModelAudioFormat } from './audio-format.js';
import { decodeAudio, encodeAudio, normalizeMono } from './codec.js';
import { StreamingLinearResampler } from './resampler.js';
import { FramedAudioQueue } from './framed-audio-queue.js';
import { AudioPacer } from './audio-pacer.js';

function concatenate(left, right) {
  if (!left.length) return right;
  if (!right.length) return left;
  return Buffer.concat([left, right]);
}

export class StreamingAudioConverter {
  #remainder = Buffer.alloc(0);

  constructor(sourceFormat, targetFormat) {
    this.sourceFormat = sourceFormat;
    this.targetFormat = targetFormat;
    if (targetFormat.channels !== 1) {
      throw new AppError(409, 'Voice runtime audio targets must declare mono output', 'VOICE_AUDIO_MONO_REQUIRED');
    }
    this.sampleBytes = sourceFormat.bytesPerSample * sourceFormat.channels;
    this.resampler = new StreamingLinearResampler(sourceFormat.sampleRate, targetFormat.sampleRate);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Audio converter input must be a Buffer');
    const combined = concatenate(this.#remainder, chunk);
    const usableBytes = combined.length - (combined.length % this.sampleBytes);
    this.#remainder = combined.subarray(usableBytes);
    if (!usableBytes) return Buffer.alloc(0);
    const decoded = decodeAudio(combined.subarray(0, usableBytes), this.sourceFormat);
    const mono = normalizeMono(decoded, this.sourceFormat.channels);
    return encodeAudio(this.resampler.push(mono), this.targetFormat);
  }

  flush() {
    if (this.#remainder.length) {
      this.reset();
      throw new AppError(400, 'Audio stream ended with an incomplete sample', 'VOICE_AUDIO_TRUNCATED_SAMPLE');
    }
    const output = encodeAudio(this.resampler.flush(), this.targetFormat);
    this.reset();
    return output;
  }

  reset() {
    this.#remainder = Buffer.alloc(0);
    this.resampler.reset();
  }
}

export class AudioFrameAccumulator {
  #buffer = Buffer.alloc(0);

  constructor(format, frameDurationMs = format.frameDurationMs) {
    this.format = format;
    this.frameDurationMs = frameDurationMs;
    this.frameBytes = audioFrameBytes(format, frameDurationMs);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Frame accumulator input must be a Buffer');
    this.#buffer = concatenate(this.#buffer, chunk);
    const frames = [];
    while (this.#buffer.length >= this.frameBytes) {
      frames.push(this.#buffer.subarray(0, this.frameBytes));
      this.#buffer = this.#buffer.subarray(this.frameBytes);
    }
    return frames;
  }

  flush() {
    const remainder = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return remainder.length ? [remainder] : [];
  }

  reset() { this.#buffer = Buffer.alloc(0); }
}

export class ProviderIndependentAudioEngine {
  constructor(options) {
    if (!options?.runtimeProfile || !options?.mediaSession) {
      throw new TypeError('Audio engine requires a runtime profile and Plivo media session');
    }
    this.runtimeProfile = options.runtimeProfile;
    this.mediaSession = options.mediaSession;
    this.telephonyFormat = options.telephonyFormat ?? PLIVO_MULAW_8K;
    this.sttFormat = resolveModelAudioFormat(options.runtimeProfile.providers?.stt, 'input');
    this.ttsFormat = resolveModelAudioFormat(options.runtimeProfile.providers?.tts, 'output');
    this.inboundConverter = new StreamingAudioConverter(this.telephonyFormat, this.sttFormat);
    this.outboundConverter = new StreamingAudioConverter(this.ttsFormat, this.telephonyFormat);
    this.outboundFrames = new AudioFrameAccumulator(this.telephonyFormat, options.frameDurationMs ?? env.VOICE_AUDIO_FRAME_MS);
    this.inputQueue = new FramedAudioQueue({
      maxFrames: options.inputMaxFrames ?? 100,
      maxBytes: options.inputMaxBytes ?? 1_048_576,
      maxBufferedMs: options.inputMaxBufferedMs ?? env.VOICE_AUDIO_INPUT_MAX_BUFFER_MS,
    });
    this.outputQueue = new FramedAudioQueue({
      maxFrames: options.outputMaxFrames ?? 100,
      maxBytes: options.outputMaxBytes ?? 1_048_576,
      maxBufferedMs: options.outputMaxBufferedMs ?? env.VOICE_AUDIO_OUTPUT_MAX_BUFFER_MS,
    });
    this.pacer = new AudioPacer({
      queue: this.outputQueue,
      send: (frame) => this.mediaSession.sendAudio(frame.data),
      onError: options.onError,
      now: options.now,
      sleep: options.sleep,
    });
    this.outputGenerationId = null;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new AppError(409, 'Audio engine is closed', 'VOICE_AUDIO_ENGINE_CLOSED');
    this.pacer.start();
    return this;
  }

  async enqueueInbound(chunk, metadata = {}) {
    const converted = this.inboundConverter.push(chunk);
    if (!converted.length) return;
    await this.inputQueue.enqueue({
      data: converted,
      durationMs: audioDurationMs(converted.length, this.sttFormat),
      metadata,
    });
  }

  readInbound(options) { return this.inputQueue.dequeue(options); }

  beginOutputGeneration(generationId = randomUUID()) {
    this.outboundConverter.reset();
    this.outboundFrames.reset();
    this.outputGenerationId = generationId;
    return generationId;
  }

  async enqueueSynthesized(chunk, generationId = this.outputGenerationId) {
    if (!generationId || generationId !== this.outputGenerationId) return false;
    const converted = this.outboundConverter.push(chunk);
    for (const data of this.outboundFrames.push(converted)) {
      if (generationId !== this.outputGenerationId) return false;
      await this.outputQueue.enqueue({
        data, generationId,
        durationMs: audioDurationMs(data.length, this.telephonyFormat),
      });
    }
    return true;
  }

  async flushSynthesized(generationId = this.outputGenerationId) {
    if (!generationId || generationId !== this.outputGenerationId) return false;
    const converted = this.outboundConverter.flush();
    const frames = [...this.outboundFrames.push(converted), ...this.outboundFrames.flush()];
    for (const data of frames) {
      if (generationId !== this.outputGenerationId) return false;
      await this.outputQueue.enqueue({
        data, generationId,
        durationMs: audioDurationMs(data.length, this.telephonyFormat),
      });
    }
    return true;
  }

  cancelStaleAudio(reason = 'caller interruption') {
    const generationId = this.outputGenerationId;
    this.outputGenerationId = null;
    this.outboundConverter.reset();
    this.outboundFrames.reset();
    const removedFrames = generationId ? this.outputQueue.cancelGeneration(generationId) : this.outputQueue.clear();
    if (this.mediaSession.started && !this.mediaSession.closed) this.mediaSession.clearAudio(reason);
    return { generationId, removedFrames };
  }

  drainOutput() { return this.pacer.drain(); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.inputQueue.close();
    this.outputQueue.close();
    await this.pacer.stop();
  }
}
