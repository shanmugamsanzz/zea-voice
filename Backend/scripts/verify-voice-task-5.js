import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { ProviderAdapterRegistry, createRuntimeAdapters, normalizeProviderKey } = await import('../src/voice/providers/registry.js');

assert.equal(normalizeProviderKey('  Sarvam TTS  '), 'sarvam-tts');
assert.equal(normalizeProviderKey('AZURE_OpenAI'), 'azure-openai');

const registry = new ProviderAdapterRegistry();
registry.register('stt', 'speech-provider', ({ providerConfig }) => ({
  providerConfig, connect() {}, sendAudio() {}, close() {},
}), { aliases: ['Speech Provider India'] });
registry.register('llm', 'language-provider', ({ providerConfig }) => ({
  providerConfig, async generate() { return { answer: 'Hello' }; },
}));
registry.register('tts', 'voice-provider', ({ providerConfig }) => ({
  providerConfig, async synthesize() {}, cancel() {}, close() {},
}));

const profile = { providers: {
  stt: { providerName: 'Speech Provider India', modelKey: 'selected-stt' },
  llm: { providerName: 'Language Provider', modelKey: 'selected-llm' },
  tts: { providerName: 'Voice Provider', modelKey: 'selected-tts' },
} };
const adapters = await createRuntimeAdapters(profile, { callId: 'call-1' }, registry);
assert.equal(adapters.stt.providerConfig.modelKey, 'selected-stt');
assert.equal(adapters.llm.providerConfig.modelKey, 'selected-llm');
assert.equal(adapters.tts.providerConfig.modelKey, 'selected-tts');

assert.throws(
  () => registry.resolve('tts', { providerName: 'Not Registered' }),
  (error) => error.code === 'VOICE_PROVIDER_ADAPTER_NOT_FOUND',
);
assert.throws(
  () => registry.register('llm', 'language-provider', () => ({ generate() {} })),
  /already registered/,
);
await assert.rejects(
  registry.create('stt', { providerName: 'Speech Provider' }).then(() => {
    const invalid = new ProviderAdapterRegistry();
    invalid.register('stt', 'invalid', () => ({}));
    return invalid.create('stt', { providerName: 'invalid' });
  }),
  /must implement connect, sendAudio, and close/,
);

assert.equal(registry.unregister('stt', 'speech-provider'), true);
assert.equal(registry.has('stt', 'Speech Provider India'), false);

console.log(JSON.stringify({ success: true, task: 'Voice Task 5 - provider adapter registry' }));
