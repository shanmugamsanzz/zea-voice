const methods = ['connect', 'sendAudio', 'flush', 'cancel', 'close', 'onEvent', 'events'];

export const sttEventTypes = Object.freeze([
  'speech_started', 'partial_transcript', 'final_transcript', 'speech_ended', 'usage', 'error',
]);

const eventTypes = new Set(sttEventTypes);

export function normalizeSttEvent(input, context = {}) {
  if (!input || !eventTypes.has(input.type)) throw new TypeError(`Unsupported normalized STT event: ${input?.type}`);
  const event = {
    type: input.type,
    sequence: input.sequence ?? context.sequence ?? null,
    at: input.at ?? Date.now(),
    providerId: input.providerId ?? context.providerId ?? null,
    modelId: input.modelId ?? context.modelId ?? null,
    requestId: input.requestId ?? null,
  };
  if (input.type === 'partial_transcript' || input.type === 'final_transcript') {
    const text = String(input.text ?? '').trim();
    if (!text) throw new TypeError('Normalized STT transcript text cannot be empty');
    Object.assign(event, {
      text,
      language: input.language ?? context.language ?? null,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
      isFinal: input.type === 'final_transcript',
    });
  }
  if (input.type === 'usage') {
    Object.assign(event, {
      audioDurationMs: Math.max(0, Number(input.audioDurationMs) || 0),
      processingLatencyMs: Number.isFinite(Number(input.processingLatencyMs))
        ? Math.max(0, Number(input.processingLatencyMs)) : null,
      audioBytes: Number.isFinite(Number(input.audioBytes)) ? Math.max(0, Number(input.audioBytes)) : null,
    });
  }
  if (input.type === 'error') {
    Object.assign(event, {
      code: String(input.code ?? 'STT_PROVIDER_ERROR'),
      message: String(input.message ?? 'Speech-to-text provider failed'),
      retryable: input.retryable === true,
    });
  }
  return Object.freeze(event);
}

export class SttEventChannel {
  #listeners = new Set();
  #queue = [];
  #waiters = [];
  #closed = false;

  constructor(context = {}) {
    this.context = context;
    this.sequence = 0;
  }

  publish(input) {
    if (this.#closed) return null;
    this.sequence += 1;
    const event = normalizeSttEvent(input, { ...this.context, sequence: this.sequence });
    for (const listener of this.#listeners) listener(event);
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false }); else this.#queue.push(event);
    return event;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('STT event listener must be a function');
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

export function assertSttAdapter(adapter) {
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`STT adapter must implement ${methods.join(', ')}; missing: ${missing.join(', ')}`);
  }
  return adapter;
}
