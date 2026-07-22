const methods = ['stream', 'cancel', 'close'];

export const llmEventTypes = Object.freeze([
  'response_started', 'text_delta', 'tool_call_delta', 'tool_call',
  'usage', 'completed', 'cancelled', 'error',
]);

const eventTypes = new Set(llmEventTypes);

export function normalizeLlmUsage(usage = {}) {
  const inputTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.completionTokens ?? 0) || 0;
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.totalTokens) || inputTokens + outputTokens,
    cachedInputTokens: Number(usage.cachedInputTokens ?? 0) || 0,
  });
}

export function normalizeLlmEvent(input, context = {}) {
  if (!input || !eventTypes.has(input.type)) throw new TypeError(`Unsupported normalized LLM event: ${input?.type}`);
  const event = {
    ...input,
    providerId: input.providerId ?? context.providerId ?? null,
    modelId: input.modelId ?? context.modelId ?? null,
    providerRequestId: input.providerRequestId ?? context.providerRequestId ?? null,
    at: input.at ?? Date.now(),
  };
  if (input.type === 'text_delta') {
    event.delta = String(input.delta ?? '');
    if (!event.delta) throw new TypeError('LLM text delta cannot be empty');
  }
  if (input.type === 'tool_call_delta') {
    event.index = Number(input.index ?? 0);
    event.id = input.id ?? null;
    event.name = input.name ?? null;
    event.argumentsDelta = String(input.argumentsDelta ?? '');
  }
  if (input.type === 'tool_call') {
    event.id = String(input.id ?? '');
    event.name = String(input.name ?? '');
    if (!event.id || !event.name) throw new TypeError('Normalized LLM tool call requires an ID and name');
    event.arguments = input.arguments && typeof input.arguments === 'object' ? input.arguments : {};
  }
  if (input.type === 'usage' || input.type === 'completed') event.usage = normalizeLlmUsage(input.usage);
  if (input.type === 'error') {
    event.code = String(input.code ?? 'LLM_PROVIDER_ERROR');
    event.message = String(input.message ?? 'Language model provider failed');
    event.retryable = input.retryable === true;
  }
  return Object.freeze(event);
}

export function assertLlmAdapter(adapter) {
  const missing = methods.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`LLM adapter must implement ${methods.join(', ')}; missing: ${missing.join(', ')}`);
  }
  return adapter;
}
