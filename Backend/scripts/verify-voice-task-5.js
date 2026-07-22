import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { ProviderAdapterRegistry, createRuntimeAdapters, normalizeProviderKey } = await import('../src/voice/providers/registry.js');

assert.equal(normalizeProviderKey('  Sarvam TTS  '), 'sarvam-tts');
assert.equal(normalizeProviderKey('AZURE_OpenAI'), 'azure-openai');

const registry = new ProviderAdapterRegistry();
registry.register('stt', 'speech-provider', ({ providerConfig }) => ({
  providerConfig, connect() {}, sendAudio() {}, flush() {}, cancel() {}, close() {},
  onEvent() {}, async *events() {},
}), { aliases: ['Speech Provider India'], supports: ({ runtime }) => runtime.protocol !== 'unsupported' });
registry.register('llm', 'language-provider', ({ providerConfig }) => ({
  providerConfig, async *stream() {}, cancel() {}, close() {},
}));
registry.register('tts', 'voice-provider', ({ providerConfig }) => ({
  providerConfig, connect() {}, async *synthesizeStream() {}, cancel() {}, close() {},
}));

const profile = { providers: {
  stt: {
    providerName: 'Renamed Speech Provider', providerSlug: 'renamed-speech', modelKey: 'selected-stt',
    modelCapabilities: { runtime: { adapter: 'speech-provider', streaming: true } },
  },
  llm: { providerName: 'Language Provider', modelKey: 'selected-llm' },
  tts: { providerName: 'Voice Provider', modelKey: 'selected-tts' },
} };
const adapters = await createRuntimeAdapters(profile, { callId: 'call-1' }, registry);
assert.equal(adapters.stt.providerConfig.modelKey, 'selected-stt');
assert.equal(adapters.llm.providerConfig.modelKey, 'selected-llm');
assert.equal(adapters.tts.providerConfig.modelKey, 'selected-tts');

assert.deepEqual(registry.preflight(profile), {
  compatible: true,
  adapters: { stt: 'speech-provider', llm: 'language-provider', tts: 'voice-provider' },
});

assert.throws(
  () => registry.resolve('tts', { providerName: 'Not Registered' }),
  (error) => error.code === 'VOICE_PROVIDER_ADAPTER_NOT_FOUND',
);
assert.throws(
  () => registry.register('llm', 'language-provider', () => ({ stream() {} })),
  /already registered/,
);
await assert.rejects(
  registry.create('stt', { providerName: 'Speech Provider' }).then(() => {
    const invalid = new ProviderAdapterRegistry();
    invalid.register('stt', 'invalid', () => ({}));
    return invalid.create('stt', { providerName: 'invalid' });
  }),
  /missing: connect, sendAudio, flush, cancel, close, onEvent, events/,
);

assert.throws(
  () => registry.preflight({ providers: {
    stt: { providerName: 'Unknown STT', modelKey: 'stt-x' },
    llm: profile.providers.llm,
    tts: { ...profile.providers.tts, modelCapabilities: { streaming: false } },
  } }),
  (error) => error.code === 'VOICE_RUNTIME_ADAPTERS_UNAVAILABLE'
    && error.details.incompatible.length === 2
    && error.details.incompatible.some((item) => item.code === 'VOICE_PROVIDER_STREAMING_UNSUPPORTED'),
);

assert.equal(registry.unregister('stt', 'speech-provider'), true);
assert.equal(registry.has('stt', 'Speech Provider India'), false);

console.log(JSON.stringify({ success: true, task: 'Voice Task 5 - provider adapter registry' }));
