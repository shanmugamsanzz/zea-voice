import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.PUBLIC_BASE_URL = 'https://api.voice.zeacrm.com';
process.env.VOICE_MEDIA_TOKEN_TTL_SECONDS = '120';

const { createVoiceCallSession } = await import('../src/voice/call-session-store.js');
const { buildPlivoStreamXml } = await import('../src/voice/plivo-answer.service.js');

const call = {
  providerCallId: 'plivo-call-1', phoneNumberId: 'phone-1', telephonyAccountId: 'account-1',
  from: '+919876543210', to: '+918035313119', direction: 'inbound',
};
const runtimeProfile = {
  agent: { id: 'agent-1', tenantId: 'tenant-1', workspaceId: 'workspace-1', name: 'Dynamic Agent' },
  providers: {
    stt: { providerId: 'stt-provider', modelId: 'stt-model' },
    llm: { providerId: 'llm-provider', modelId: 'llm-model' },
    tts: { providerId: 'tts-provider', modelId: 'tts-model' },
  },
};
const inserted = {
  id: 'call-session-1', tenant_id: 'tenant-1', workspace_id: 'workspace-1', provider_call_id: 'plivo-call-1',
  agent_id: 'agent-1', from_number: call.from, to_number: call.to, direction: 'inbound', status: 'connected',
};
let queryNumber = 0;
let insertValues;
const contextRunner = async (operation) => operation({ query: async (_sql, values) => {
  queryNumber += 1;
  if (queryNumber === 1) return { rowCount: 0, rows: [] };
  insertValues = values;
  return { rowCount: 1, rows: [inserted] };
} });

const session = await createVoiceCallSession({ call, runtimeProfile }, { contextRunner });
assert.equal(session.id, inserted.id);
assert.equal(session.created, true);
const metadata = JSON.parse(insertValues.at(-1));
assert.equal(metadata.sttProviderId, 'stt-provider');
assert.equal(metadata.ttsModelId, 'tts-model');

const xml = buildPlivoStreamXml(session, { secret: 'test-signing-secret-with-at-least-32-characters', now: 1_700_000_000_000 });
assert.match(xml, /bidirectional="true"/);
assert.match(xml, /keepCallAlive="true"/);
assert.match(xml, /wss:\/\/api\.voice\.zeacrm\.com\/webhooks\/plivo\/media\?call_id=call-session-1/);
assert.match(xml, /&amp;/);

console.log(JSON.stringify({ success: true, task: 'Voice Task 4 - create call session and audio stream' }));
