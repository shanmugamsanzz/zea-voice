import { normalizeAudioFormat } from '../../audio/audio-format.js';

const methods = ['connect', 'sendCustomerAudio', 'cancelResponse', 'close', 'onEvent', 'events'];

export const audioToAudioEventTypes = Object.freeze([
  'input_speech_started', 'input_speech_ended', 'response_started', 'agent_audio',
  'response_completed', 'cancelled', 'usage', 'error',
]);

const eventTypes = new Set(audioToAudioEventTypes);

export function normalizeAudioToAudioUsage(input = {}) {
  return Object.freeze({
    audioInputBytes: Math.max(0, Number(input.audioInputBytes) || 0),
    audioOutputBytes: Math.max(0, Number(input.audioOutputBytes) || 0),
    audioInputMs: Math.max(0, Number(input.audioInputMs) || 0),
    audioOutputMs: Math.max(0, Number(input.audioOutputMs) || 0),
    inputTokens: Math.max(0, Number(input.inputTokens) || 0),
    outputTokens: Math.max(0, Number(input.outputTokens) || 0),
    cachedInputTokens: Math.max(0, Number(input.cachedInputTokens ?? input.cached_input_tokens) || 0),
    audioInputTokens: Math.max(0, Number(input.audioInputTokens ?? input.audio_input_tokens) || 0),
    audioOutputTokens: Math.max(0, Number(input.audioOutputTokens ?? input.audio_output_tokens) || 0),
    totalTokens: Math.max(0, Number(input.totalTokens) || 0),
    requests: Math.max(0, Number(input.requests ?? input.requestCount ?? 1) || 0),
    cost: Number.isFinite(Number(input.cost)) ? Math.max(0, Number(input.cost)) : null,
  });
}

export function normalizeAudioToAudioEvent(input, context = {}) {
  if (!eventTypes.has(input?.type)) throw new TypeError(`Unsupported Audio-to-Audio event type: ${input?.type}`);
  const event = {
    type: input.type,
    sequence: input.sequence ?? context.sequence ?? null,
    at: input.at ?? Date.now(),
    providerId: context.providerId ?? null,
    modelId: context.modelId ?? null,
    responseId: input.responseId ?? null,
  };
  if (input.type === 'agent_audio') {
    if (!Buffer.isBuffer(input.audio) || !input.audio.length) throw new TypeError('Audio-to-Audio agent_audio requires audio bytes');
    event.audio = input.audio;
    event.format = normalizeAudioFormat(input.format);
  }
  if (input.type === 'usage' || input.type === 'response_completed') event.usage = normalizeAudioToAudioUsage(input.usage ?? input);
  if (input.type === 'cancelled') event.reason = String(input.reason ?? 'cancelled');
  if (input.type === 'error') {
    event.code = String(input.code ?? 'AUDIO_TO_AUDIO_PROVIDER_ERROR');
    event.message = String(input.message ?? 'Audio-to-Audio provider failed');
    event.retryable = input.retryable === true;
  }
  return Object.freeze(event);
}

export class AudioToAudioEventChannel {
  #listeners = new Set();
  #queue = [];
  #waiters = [];
  #closed = false;

  constructor(context = {}) { this.context = context; this.sequence = 0; }

  publish(input) {
    if (this.#closed) return null;
    this.sequence += 1;
    const event = normalizeAudioToAudioEvent(input, { ...this.context, sequence: this.sequence });
    for (const listener of this.#listeners) listener(event);
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false }); else this.#queue.push(event);
    return event;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Audio-to-Audio event listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async *iterate() {
    while (true) {
      if (this.#queue.length) yield this.#queue.shift();
      else if (this.#closed) return;
      else {
        const result = await new Promise((resolve) => this.#waiters.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const resolve of this.#waiters.splice(0)) resolve({ value: undefined, done: true });
    this.#listeners.clear();
  }
}

export function assertAudioToAudioAdapter(adapter) {
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) throw new TypeError(`Audio-to-Audio adapter must implement ${methods.join(', ')}; missing: ${missing.join(', ')}`);
  return adapter;
}
