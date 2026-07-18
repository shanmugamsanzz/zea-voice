import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { loadAgentRuntimeProfile } = await import('../src/voice/providers/provider-config.js');

const resolved = {
  agentId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  workspaceId: '00000000-0000-4000-8000-000000000003',
};
const row = {
  id: resolved.agentId, tenant_id: resolved.tenantId, workspace_id: resolved.workspaceId,
  name: 'Dynamic Agent', description: 'Test agent', goal: 'Help callers', language: 'English (US)',
  usage_direction: 'both', prompt: 'Be helpful', welcome_message: 'Hello', temperature: '0.4',
  interruption_sensitivity: '0.3', silence_timeout_ms: 600, inactivity_timeout_seconds: 8,
  settings: { greetingMode: 'Agent Initiates' },
};
for (const type of ['stt', 'llm', 'tts']) {
  Object.assign(row, {
    [`${type}_model_id`]: `${type}-model-id`, [`${type}_model_key`]: `${type}-model`,
    [`${type}_model_name`]: `${type.toUpperCase()} Model`, [`${type}_model_settings`]: { streaming: true },
    [`${type}_model_capabilities`]: { languages: ['en'] }, [`${type}_provider_id`]: `${type}-provider-id`,
    [`${type}_provider_name`]: `${type.toUpperCase()} Provider`, [`${type}_base_url`]: `https://${type}.example.com`,
    [`${type}_parameters`]: [
      { key: `${type.toUpperCase()}_MODEL`, plainValue: `${type}-model`, encryptedValue: null, isSecret: false },
      { key: `${type.toUpperCase()}_API_KEY`, plainValue: null, encryptedValue: `encrypted-${type}`, isSecret: true },
    ],
  });
}
const contextRunner = async (operation) => operation({ query: async () => ({ rowCount: 1, rows: [row] }) });
const profile = await loadAgentRuntimeProfile(resolved, {
  contextRunner,
  decryptCredential: (value) => `decrypted:${value}`,
});

assert.equal(profile.agent.id, resolved.agentId);
assert.equal(profile.agent.temperature, 0.4);
assert.equal(profile.providers.stt.modelKey, 'stt-model');
assert.equal(profile.providers.llm.parameters.LLM_API_KEY, 'decrypted:encrypted-llm');
assert.equal(profile.providers.tts.modelCapabilities.languages[0], 'en');

const unavailableRunner = async (operation) => operation({ query: async () => ({ rowCount: 0, rows: [] }) });
await assert.rejects(
  loadAgentRuntimeProfile(resolved, { contextRunner: unavailableRunner }),
  (error) => error.code === 'VOICE_RUNTIME_PROFILE_UNAVAILABLE',
);

console.log(JSON.stringify({ success: true, task: 'Voice Task 3 - load dynamic runtime profile' }));
