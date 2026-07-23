const methods = ['connect', 'synthesizeStream', 'cancel', 'close'];

export const ttsEventTypes = Object.freeze([
  'audio_chunk', 'usage', 'completed', 'cancelled', 'error',
]);

const eventTypes = new Set(ttsEventTypes);

export function normalizeTtsUsage(input = {}) {
  return Object.freeze({
    characters: Math.max(0, Number(input.characters) || 0),
    audioOutputMs: Math.max(0, Number(input.audioOutputMs) || 0),
    audioBytes: Math.max(0, Number(input.audioBytes) || 0),
    firstAudioLatencyMs: Number.isFinite(Number(input.firstAudioLatencyMs))
      ? Math.max(0, Number(input.firstAudioLatencyMs)) : null,
    cost: Number.isFinite(Number(input.cost)) ? Math.max(0, Number(input.cost)) : null,
  });
}

export function normalizeTtsEvent(input, context = {}) {
  if (!eventTypes.has(input?.type)) throw new TypeError(`Unsupported TTS event type: ${input?.type}`);
  const event = {
    type: input.type,
    generationId: input.generationId ?? context.generationId ?? null,
    providerId: context.providerId ?? null,
    modelId: context.modelId ?? null,
  };
  if (input.type === 'audio_chunk') {
    if (!Buffer.isBuffer(input.audio) || !input.audio.length) {
      throw new TypeError('TTS audio_chunk events require a non-empty audio Buffer');
    }
    event.audio = input.audio;
    event.sequence = Math.max(0, Number(input.sequence) || 0);
  }
  if (input.type === 'usage') event.usage = normalizeTtsUsage(input.usage ?? input);
  if (input.type === 'completed') event.usage = normalizeTtsUsage(input.usage ?? input);
  if (input.type === 'cancelled') event.reason = String(input.reason ?? 'cancelled');
  if (input.type === 'error') {
    event.code = String(input.code ?? 'TTS_PROVIDER_ERROR');
    event.message = String(input.message ?? 'TTS provider failed');
    event.retryable = input.retryable === true;
  }
  return Object.freeze(event);
}

export function assertTtsAdapter(adapter) {
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`TTS adapter must implement ${methods.join(', ')}; missing: ${missing.join(', ')}`);
  }
  return adapter;
}
