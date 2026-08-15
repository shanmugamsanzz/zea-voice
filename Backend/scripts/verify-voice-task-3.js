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
  phone_number_id: '00000000-0000-4000-8000-000000000004', voice_id: 'selected-voice',
  name: 'Dynamic Agent', description: 'Test agent', goal: 'Help callers', language: 'English (US)',
  usage_direction: 'both', prompt: 'Be helpful', welcome_message: 'Hello', temperature: '0.4',
  interruption_sensitivity: '0.3', silence_timeout_ms: 600, inactivity_timeout_seconds: 8,
  settings: {
    greetingMode: 'Agent Initiates', sttLanguage: 'en-IN', sttMode: 'transcribe',
    ttsMaxCharactersPerMinute: 1000, maxCallDurationMinutes: 5,
    ttsLanguage: 'legacy-agent-value', ttsSpeed: 1.1, silentMessage: 'Are you still there?',
    preCallApiActive: true, preCallApiUrl: 'https://example.com/pre', preCallApiMethod: 'POST',
    postCallEndpointDetailsActive: true, postCallApiUrl: 'https://example.com/post', postCallApiMethod: 'POST',
  },
  tools: [{
    id: 'tool-id', name: 'Lookup_Record', type: 'webhook_api', description: 'Retrieve a current record',
    configuration: {
      url: 'https://example.com/lookup',
      inputSchema: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
    },
    secretConfigurationEncrypted: 'encrypted-tool',
  }],
  knowledge_bases: [{
    id: 'kb-id', name: 'Published KB', description: 'Published knowledge', usageDirection: 'both',
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
row.tts_model_settings = { streaming: true, ttsLanguage: 'en-IN', ttsSpeed: 0.9 };
const contextRunner = async (operation) => operation({ query: async () => ({ rowCount: 1, rows: [row] }) });
const profile = await loadAgentRuntimeProfile(resolved, {
  contextRunner,
  decryptCredential: (value) => value === 'encrypted-tool'
    ? JSON.stringify({ token: 'decrypted-tool-token' })
    : `decrypted:${value}`,
});

assert.equal(profile.agent.id, resolved.agentId);
assert.equal(profile.agent.temperature, 0.4);
assert.equal(profile.agent.voiceId, 'selected-voice');
assert.equal(profile.agent.callDirection, 'inbound');
assert.equal(profile.agent.speech.listener.sttLanguage, 'en-IN');
assert.equal(Object.hasOwn(profile.agent.speech.speaker, 'ttsSpeed'), false);
assert.equal(profile.providers.stt.modelKey, 'stt-model');
assert.equal(profile.providers.stt.effectiveSettings.STT_MODEL, 'stt-model');
assert.equal(Object.hasOwn(profile.providers.stt.effectiveSettings, 'STT_API_KEY'), false);
assert.equal(profile.providers.llm.parameters.LLM_API_KEY, 'decrypted:encrypted-llm');
assert.equal(profile.providers.tts.modelCapabilities.languages[0], 'en');
assert.equal(profile.providers.tts.effectiveSettings.voiceId, 'selected-voice');
assert.equal(profile.providers.tts.effectiveSettings.ttsLanguage, 'en-IN');
assert.equal(profile.providers.tts.effectiveSettings.ttsSpeed, 0.9);
assert.deepEqual(profile.limits, {
  ttsMaxCharactersPerResponse: 0,
  ttsMaxCharactersPerMinute: 1000,
  maxCallDurationMinutes: 5,
  ttsLimitFallbackMessage: '',
});
assert.equal(profile.knowledgeBases[0].name, 'Published KB');
assert.equal(profile.tools[0].secretConfiguration.token, 'decrypted-tool-token');
assert.equal(profile.configuration.scope.tenantId, resolved.tenantId);
assert.equal(profile.configuration.scope.workspaceId, resolved.workspaceId);
assert.equal(profile.configuration.prompt.system, 'Be helpful');
assert.equal(profile.configuration.knowledge.assignedPublishedRevisions[0].knowledgeBaseId, 'kb-id');
assert.equal(profile.configuration.tools[0].name, 'Lookup_Record');
assert.deepEqual(profile.configuration.tools[0].inputSchema.required, ['reference']);
assert.equal(profile.configuration.speech.voiceId, 'selected-voice');
assert.equal(profile.integrations.preCall.api.url, 'https://example.com/pre');
assert.equal(profile.integrations.postCall.api.active, true);

const unavailableRunner = async (operation) => operation({ query: async () => ({ rowCount: 0, rows: [] }) });
await assert.rejects(
  loadAgentRuntimeProfile(resolved, { contextRunner: unavailableRunner }),
  (error) => error.code === 'VOICE_RUNTIME_PROFILE_UNAVAILABLE',
);

console.log(JSON.stringify({ success: true, task: 'Voice Task 3 - load dynamic runtime profile' }));
