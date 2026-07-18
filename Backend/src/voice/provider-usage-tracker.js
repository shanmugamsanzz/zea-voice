const providerKinds = new Set(['telephony', 'stt', 'llm', 'tts']);
const numericFields = [
  'requests', 'inputTokens', 'outputTokens', 'totalTokens', 'audioInputMs',
  'audioOutputMs', 'characters', 'durationMs', 'cost',
];

function nonnegative(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a non-negative number`);
  return number;
}

function identity(kind, provider = {}) {
  return {
    kind,
    providerId: provider.providerId ?? null,
    providerName: provider.providerName ?? null,
    modelId: provider.modelId ?? null,
    model: provider.modelKey ?? provider.model ?? null,
  };
}

function key(value) {
  return [value.kind, value.providerId, value.modelId].map((item) => item ?? '').join(':');
}

export class ProviderUsageTracker {
  #records = new Map();

  constructor(runtimeProfile, options = {}) {
    this.currency = options.currency ?? 'INR';
    this.providers = runtimeProfile?.providers ?? {};
  }

  record(kind, usage = {}, providerOverride) {
    if (!providerKinds.has(kind)) throw new TypeError(`Unsupported provider usage kind: ${kind}`);
    const provider = providerOverride ?? this.providers[kind] ?? {};
    const providerIdentity = identity(kind, provider);
    const recordKey = key(providerIdentity);
    const current = this.#records.get(recordKey) ?? {
      ...providerIdentity,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      audioInputMs: 0,
      audioOutputMs: 0,
      characters: 0,
      durationMs: 0,
      cost: 0,
      currency: usage.currency ?? this.currency,
      events: [],
    };
    const normalized = {
      requests: usage.requests ?? usage.requestCount ?? 1,
      inputTokens: usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens,
      outputTokens: usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens,
      totalTokens: usage.totalTokens ?? usage.total_tokens,
      audioInputMs: usage.audioInputMs ?? usage.inputAudioMs,
      audioOutputMs: usage.audioOutputMs ?? usage.outputAudioMs,
      characters: usage.characters ?? usage.characterCount,
      durationMs: usage.durationMs,
      cost: usage.cost,
    };
    for (const field of numericFields) current[field] += nonnegative(normalized[field], field);
    if (!normalized.totalTokens) current.totalTokens = current.inputTokens + current.outputTokens;
    if (usage.currency && usage.currency !== current.currency) {
      throw new TypeError('Provider usage currencies cannot be mixed in one report');
    }
    current.events.push(structuredClone(usage));
    this.#records.set(recordKey, current);
    return this.report();
  }

  report() {
    const providers = [...this.#records.values()].map((record) => structuredClone(record));
    return {
      providers,
      totals: providers.reduce((totals, record) => {
        for (const field of numericFields) totals[field] += record[field];
        return totals;
      }, Object.fromEntries(numericFields.map((field) => [field, 0]))),
    };
  }
}
