import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { ProviderAdapterRegistry, validateRuntimeAdapterConfiguration } = await import('../src/voice/providers/registry.js');

function adapter() {
  return { connect() {}, sendAudio() {}, flush() {}, synthesizeStream() {}, stream() {}, cancel() {}, cancelResponse() {}, sendCustomerAudio() {}, close() {}, onEvent() {}, events() {} };
}

const registry = new ProviderAdapterRegistry();
for (const kind of ['stt', 'llm', 'tts']) {
  registry.register(kind, `${kind}-safe`, () => adapter(), {
    supports: ({ providerConfig }) => providerConfig.modelKey === `${kind}-valid`,
  });
}
registry.register('audio_to_audio', 'audio-safe', () => adapter(), {
  supports: ({ providerConfig }) => providerConfig.modelKey === 'audio-valid',
});

const profile = { providers: {
  stt: { providerName: 'stt-safe', modelKey: 'stt-valid' },
  llm: { providerName: 'llm-safe', modelKey: 'llm-valid' },
  tts: { providerName: 'tts-safe', modelKey: 'tts-valid' },
  audio_to_audio: { providerName: 'audio-safe', modelKey: 'audio-valid' },
} };
assert.deepEqual(await validateRuntimeAdapterConfiguration(profile, registry), {
  compatible: true, adapters: { stt: 'stt-safe', llm: 'llm-safe', tts: 'tts-safe', audio_to_audio: 'audio-safe' },
});

assert.throws(
  () => registry.resolve('stt', { providerName: 'stt-safe', modelKey: 'another-tenant-model' }),
  (error) => error.code === 'VOICE_PROVIDER_MODEL_INCOMPATIBLE',
);

const parameterRegistry = new ProviderAdapterRegistry();
for (const kind of ['stt', 'llm', 'tts']) parameterRegistry.register(kind, `${kind}-required`, ({ providerConfig }) => {
  if (!providerConfig.parameters?.API_KEY) {
    const error = new Error('missing key'); error.code = 'STT_API_KEY_MISSING'; throw error;
  }
  return adapter();
});
await assert.rejects(
  parameterRegistry.validate('stt', { providerName: 'stt-required', modelKey: 'model', parameters: {} }),
  (error) => error.code === 'VOICE_RUNTIME_REQUIRED_PARAMETER_MISSING'
    && error.message === 'Required runtime provider parameters are missing.',
);

const failingRegistry = new ProviderAdapterRegistry();
for (const kind of ['stt', 'llm', 'tts']) failingRegistry.register(kind, `${kind}-failure`, () => {
  const error = new Error('bad capability'); error.code = 'STT_AUDIO_FORMAT_UNSUPPORTED'; throw error;
});
await assert.rejects(
  failingRegistry.validate('stt', { providerName: 'stt-failure', modelKey: 'model' }),
  (error) => error.code === 'VOICE_RUNTIME_ADAPTER_UNAVAILABLE'
    && error.message === 'Runtime adapter is not available for this provider/model.',
);

console.log(JSON.stringify({ success: true, task: 'Runtime adapter validation and safe selection' }));
