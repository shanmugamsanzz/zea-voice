import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { resolvePhoneNumberAgent } = await import('../src/voice/agent-resolver.service.js');

const ids = {
  phone: '00000000-0000-4000-8000-000000000001',
  tenant: '00000000-0000-4000-8000-000000000002',
  workspace: '00000000-0000-4000-8000-000000000003',
  agent: '00000000-0000-4000-8000-000000000004',
};

function runner({ direction = 'both', modelsAvailable = true } = {}) {
  let queryNumber = 0;
  return async (operation) => operation({ query: async () => {
    queryNumber += 1;
    if (queryNumber === 1) return { rowCount: 1, rows: [{ tenant_id: ids.tenant }] };
    if (queryNumber === 2) return { rowCount: 1, rows: [{
      id: ids.agent, tenant_id: ids.tenant, workspace_id: ids.workspace, name: 'Test Agent',
      language: 'English (US)', usage_direction: direction,
      stt_model_id: 'stt-id', llm_model_id: 'llm-id', tts_model_id: 'tts-id',
    }] };
    return { rowCount: modelsAvailable ? 1 : 0, rows: modelsAvailable ? [{
      stt_model_id: 'stt-id', stt_model_key: 'stt-model', stt_model_name: 'STT', stt_provider_id: 'stt-provider', stt_provider_name: 'STT Provider',
      llm_model_id: 'llm-id', llm_model_key: 'llm-model', llm_model_name: 'LLM', llm_provider_id: 'llm-provider', llm_provider_name: 'LLM Provider',
      tts_model_id: 'tts-id', tts_model_key: 'tts-model', tts_model_name: 'TTS', tts_provider_id: 'tts-provider', tts_provider_name: 'TTS Provider',
    }] : [] };
  } });
}

const call = { phoneNumberId: ids.phone, to: '+918035313119', direction: 'inbound' };
const resolved = await resolvePhoneNumberAgent(call, { contextRunner: runner() });
assert.equal(resolved.agentId, ids.agent);
assert.equal(resolved.stt.modelKey, 'stt-model');
assert.equal(resolved.llm.modelKey, 'llm-model');
assert.equal(resolved.tts.modelKey, 'tts-model');

await assert.rejects(
  resolvePhoneNumberAgent(call, { contextRunner: runner({ direction: 'outbound' }) }),
  (error) => error.code === 'VOICE_AGENT_DIRECTION_MISMATCH',
);
await assert.rejects(
  resolvePhoneNumberAgent(call, { contextRunner: runner({ modelsAvailable: false }) }),
  (error) => error.code === 'VOICE_AGENT_MODEL_UNAVAILABLE',
);

console.log(JSON.stringify({ success: true, task: 'Voice Task 2 - resolve phone number and agent' }));
