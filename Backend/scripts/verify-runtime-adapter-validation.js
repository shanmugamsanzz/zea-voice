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

const { validateAgentRuntimeModels } = await import('../src/agents/agent.service.js');
const agentClient = {
  async query(_sql, [_modelId, kind]) {
    return { rowCount: 1, rows: [{
      model_id: `${kind}-model`, model_key: 'model', provider_name: `${kind}-required`,
      provider_slug: `${kind}-required`, provider_status: 'connected',
      runtime_connection_type: kind === 'llm' ? 'openai' : 'sarvam',
      provider_settings: { API_KEY: '__configured_secret__' },
    }] };
  },
};
await validateAgentRuntimeModels(agentClient, {
  sttModelId: 'stt-model', llmModelId: 'llm-model', ttsModelId: 'tts-model',
}, parameterRegistry);
await assert.rejects(validateAgentRuntimeModels({
  async query(...args) {
    const result = await agentClient.query(...args);
    result.rows[0].provider_settings = {};
    return result;
  },
}, { sttModelId: 'stt-model' }, parameterRegistry),
(error) => error.code === 'AGENT_MODEL_RUNTIME_INCOMPATIBLE'
  && error.message === 'Selected STT model is missing required runtime provider parameters');

// Exercise the actual Sarvam factory: credentials, language, audio and endpoint
// must all reach validation without opening a provider connection.
const sarvamClient = {
  async query(...args) {
    const result = await agentClient.query(...args);
    if (args[1][1] === 'stt') Object.assign(result.rows[0], {
      provider_name: 'Sarvam', provider_slug: 'sarvam', model_key: 'saaras:v3',
      base_url: 'https://api.sarvam.ai', model_settings: { sttLanguage: 'ta-IN' },
      model_capabilities: { audio: { input: {
        encoding: 'pcm_s16le', sampleRate: 16000, channels: 1,
      } } },
    });
    return result;
  },
};
await validateAgentRuntimeModels(sarvamClient, {
  sttModelId: 'stt-model', llmModelId: 'llm-model', ttsModelId: 'tts-model',
}, parameterRegistry);
await assert.rejects(validateAgentRuntimeModels({
  async query(...args) {
    const result = await sarvamClient.query(...args);
    result.rows[0].base_url = null;
    return result;
  },
}, { sttModelId: 'stt-model' }, parameterRegistry),
(error) => error.details.reason === 'STT_BASE_URL_MISSING'
  && error.message.includes('STT_BASE_URL_MISSING'));

console.log(JSON.stringify({ success: true, task: 'Runtime adapter validation and safe selection' }));
