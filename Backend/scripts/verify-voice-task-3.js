import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { loadAgentRuntimeProfile } = await import('../src/voice/providers/provider-config.js');

const resolved = {
  agentId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  workspaceId: '00000000-0000-4000-8000-000000000003',
  callDirection: 'inbound',
};
const row = {
  id: resolved.agentId, tenant_id: resolved.tenantId, workspace_id: resolved.workspaceId,
  phone_number_id: '00000000-0000-4000-8000-000000000004', voice_id: 'hospital-voice',
  name: 'Dynamic Agent', description: 'Test agent', goal: 'Help callers', language: 'English (US)',
  usage_direction: 'both', prompt: 'Be helpful', welcome_message: 'Hello', temperature: '0.4',
  interruption_sensitivity: '0.3', silence_timeout_ms: 600, inactivity_timeout_seconds: 8,
  settings: {
    greetingMode: 'Agent Initiates', sttLanguage: 'en-IN', sttMode: 'transcribe',
    ttsLanguage: 'en-IN', ttsSpeed: 1.1, silentMessage: 'Are you still there?',
    preCallApiActive: true, preCallApiUrl: 'https://example.com/pre', preCallApiMethod: 'POST',
    postCallEndpointDetailsActive: true, postCallApiUrl: 'https://example.com/post', postCallApiMethod: 'POST',
  },
  tools: [{
    id: 'tool-id', name: 'Appointment', type: 'webhook_api', description: 'Book appointment',
    configuration: { url: 'https://example.com/book' }, secretConfigurationEncrypted: 'encrypted-tool',
  }],
  knowledge_bases: [{
    id: 'kb-id', name: 'Hospital KB', description: 'Published knowledge', usageDirection: 'both',
    priority: 10, publicationRevision: 2, semanticReady: true, settings: {},
  }],
};
for (const type of ['stt', 'llm', 'tts']) {
  Object.assign(row, {
    [`${type}_model_id`]: `${type}-model-id`, [`${type}_model_key`]: `${type}-model`,
    [`${type}_model_name`]: `${type.toUpperCase()} Model`, [`${type}_model_settings`]: { streaming: true },
    [`${type}_model_capabilities`]: { languages: ['en'] }, [`${type}_provider_id`]: `${type}-provider-id`,
    [`${type}_provider_name`]: `${type.toUpperCase()} Provider`, [`${type}_provider_slug`]: `${type}-provider`,
    [`${type}_base_url`]: `https://${type}.example.com`,
    [`${type}_parameters`]: [
      { key: `${type.toUpperCase()}_MODEL`, plainValue: `${type}-model`, encryptedValue: null, isSecret: false },
      { key: `${type.toUpperCase()}_API_KEY`, plainValue: null, encryptedValue: `encrypted-${type}`, isSecret: true },
    ],
  });
}
const contextRunner = async (operation) => operation({ query: async () => ({ rowCount: 1, rows: [row] }) });
const profile = await loadAgentRuntimeProfile(resolved, {
  contextRunner,
  decryptCredential: (value) => value === 'encrypted-tool'
    ? JSON.stringify({ token: 'decrypted-tool-token' })
    : `decrypted:${value}`,
});

assert.equal(profile.agent.id, resolved.agentId);
assert.equal(profile.agent.temperature, 0.4);
assert.equal(profile.agent.voiceId, 'hospital-voice');
assert.equal(profile.agent.callDirection, 'inbound');
assert.equal(profile.agent.speech.listener.sttLanguage, 'en-IN');
assert.equal(profile.agent.speech.speaker.ttsSpeed, 1.1);
assert.equal(profile.providers.stt.modelKey, 'stt-model');
assert.equal(profile.providers.stt.effectiveSettings.STT_MODEL, 'stt-model');
assert.equal(Object.hasOwn(profile.providers.stt.effectiveSettings, 'STT_API_KEY'), false);
assert.equal(profile.providers.llm.parameters.LLM_API_KEY, 'decrypted:encrypted-llm');
assert.equal(profile.providers.tts.modelCapabilities.languages[0], 'en');
assert.equal(profile.providers.tts.effectiveSettings.voiceId, 'hospital-voice');
assert.equal(profile.knowledgeBases[0].name, 'Hospital KB');
assert.equal(profile.tools[0].secretConfiguration.token, 'decrypted-tool-token');
assert.equal(profile.integrations.preCall.api.url, 'https://example.com/pre');
assert.equal(profile.integrations.postCall.api.active, true);

const unavailableRunner = async (operation) => operation({ query: async () => ({ rowCount: 0, rows: [] }) });
await assert.rejects(
  loadAgentRuntimeProfile(resolved, { contextRunner: unavailableRunner }),
  (error) => error.code === 'VOICE_RUNTIME_PROFILE_UNAVAILABLE',
);

console.log(JSON.stringify({ success: true, task: 'Voice Task 3 - load dynamic runtime profile' }));
