import { AppError } from '../../middleware/errors.js';

function abortError() {
  return new AppError(499, 'Audio queue operation was cancelled', 'VOICE_AUDIO_QUEUE_ABORTED');
}

export class FramedAudioQueue {
  #frames = [];
  #readers = [];
  #writers = [];
  #closed = false;
  #closeError = null;
  #bytes = 0;
  #durationMs = 0;

  constructor(options = {}) {
    this.maxFrames = options.maxFrames ?? 100;
    this.maxBytes = options.maxBytes ?? 1_048_576;
    this.maxBufferedMs = options.maxBufferedMs ?? 2_000;
    if (![this.maxFrames, this.maxBytes, this.maxBufferedMs].every((value) => Number.isFinite(value) && value > 0)) {
      throw new TypeError('Audio queue limits must be positive numbers');
    }
  }

  get size() { return this.#frames.length; }
  get bufferedBytes() { return this.#bytes; }
  get bufferedMs() { return this.#durationMs; }
  get closed() { return this.#closed; }

  #hasCapacity(frame) {
    if (!this.#frames.length) return true;
    return this.#frames.length < this.maxFrames
      && this.#bytes + frame.data.length <= this.maxBytes
      && this.#durationMs + frame.durationMs <= this.maxBufferedMs;
  }

  #assertFrame(frame) {
    if (!frame || !Buffer.isBuffer(frame.data) || !frame.data.length) {
      throw new TypeError('Audio frame data must be a non-empty Buffer');
    }
    if (!Number.isFinite(frame.durationMs) || frame.durationMs <= 0) {
      throw new TypeError('Audio frame duration must be a positive number');
    }
  }

  async enqueue(frame, options = {}) {
    this.#assertFrame(frame);
    if (frame.data.length > this.maxBytes || frame.durationMs > this.maxBufferedMs) {
      throw new AppError(413, 'Audio frame exceeds queue capacity', 'VOICE_AUDIO_FRAME_TOO_LARGE');
    }
    while (!this.#closed && !this.#hasCapacity(frame)) await this.#waitForCapacity(options.signal);
    if (this.#closed) throw this.#closeError ?? new AppError(409, 'Audio queue is closed', 'VOICE_AUDIO_QUEUE_CLOSED');

    const reader = this.#readers.shift();
    if (reader) {
      reader.cleanup();
      reader.resolve(frame);
      return;
    }
    this.#frames.push(frame);
    this.#bytes += frame.data.length;
    this.#durationMs += frame.durationMs;
  }

  #waitForCapacity(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) };
      const onAbort = () => {
        const index = this.#writers.indexOf(waiter);
        if (index >= 0) this.#writers.splice(index, 1);
        waiter.cleanup();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#writers.push(waiter);
    });
  }

  async dequeue(options = {}) {
    if (this.#frames.length) return this.#shift();
    if (this.#closed) {
      if (this.#closeError) throw this.#closeError;
      return null;
    }
    if (options.signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: () => options.signal?.removeEventListener('abort', onAbort) };
      const onAbort = () => {
        const index = this.#readers.indexOf(waiter);
        if (index >= 0) this.#readers.splice(index, 1);
        waiter.cleanup();
        reject(abortError());
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#readers.push(waiter);
    });
  }

  #shift() {
    const frame = this.#frames.shift();
    this.#bytes -= frame.data.length;
    this.#durationMs -= frame.durationMs;
    this.#releaseWriters();
    return frame;
  }

  #releaseWriters() {
    const writers = this.#writers.splice(0);
    for (const waiter of writers) {
      waiter.cleanup();
      waiter.resolve();
    }
  }

  clear(predicate = () => true) {
    const retained = [];
    let removed = 0;
    this.#bytes = 0;
    this.#durationMs = 0;
    for (const frame of this.#frames) {
      if (predicate(frame)) removed += 1;
      else {
        retained.push(frame);
        this.#bytes += frame.data.length;
        this.#durationMs += frame.durationMs;
      }
    }
    this.#frames = retained;
    if (removed) this.#releaseWriters();
    return removed;
  }

  cancelGeneration(generationId) {
    return this.clear((frame) => frame.generationId === generationId);
  }

  close(error = null) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    this.clear();
    for (const waiter of this.#readers.splice(0)) {
      waiter.cleanup();
      if (error) waiter.reject(error); else waiter.resolve(null);
    }
    for (const waiter of this.#writers.splice(0)) {
      waiter.cleanup();
      waiter.reject(error ?? new AppError(409, 'Audio queue is closed', 'VOICE_AUDIO_QUEUE_CLOSED'));
    }
  }
}
