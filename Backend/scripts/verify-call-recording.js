import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.PUBLIC_BASE_URL = 'https://api.voice.zeacrm.com';
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const { encryptCredential } = await import('../src/security/credential-crypto.js');
const { buildPlivoStreamXml } = await import('../src/voice/plivo-answer.service.js');
const {
  acceptPlivoRecordingCallback, loadStoredCallRecording, processPlivoRecording,
} = await import('../src/telephony/plivo-recording.service.js');

const callId = '11111111-1111-4111-8111-111111111111';
const providerCallId = 'plivo-call-1';
const encryptedToken = encryptCredential('associated-secret');
const encryptedMainToken = encryptCredential('main-secret');
const baseCall = {
  id: callId,
  tenant_id: 'tenant-1',
  workspace_id: 'workspace-1',
  provider_call_id: providerCallId,
  auth_id: 'associated-id',
  auth_token_encrypted: encryptedToken,
  main_auth_id: 'main-id',
  main_auth_token_encrypted: encryptedMainToken,
  recording_callback_url: 'https://api.voice.zeacrm.com/webhooks/plivo/recording',
};

const xml = buildPlivoStreamXml({ id: callId, providerCallId }, {
  secret: 'test-signing-secret-with-at-least-32-characters',
  recordingEnabled: true,
  recordingCallbackUrl: baseCall.recording_callback_url,
});
assert.match(xml, /<Record recordSession="true"/);
assert.match(xml, /callbackUrl="https:\/\/api\.voice\.zeacrm\.com\/webhooks\/plivo\/recording\?call_id=/);
assert.match(xml, /fileFormat="mp3"/);
assert.ok(xml.indexOf('<Record') < xml.indexOf('<Stream'));

let queued;
const callback = await acceptPlivoRecordingCallback({
  callId,
  nonce: 'nonce',
  signature: 'signature',
  payload: {
    RecordingID: 'recording:id/unsafe',
    RecordUrl: 'https://media.plivo.com/recording.mp3',
    RecordingDurationMs: '1234',
    CallUUID: providerCallId,
  },
}, {
  loadContext: async () => baseCall,
  validateSignatures: () => true,
  savePending: async (operation) => operation({
    query: async (sql) => sql.includes('FOR UPDATE')
      ? { rows: [{ recording_object_key: null, provider_metadata: {} }] }
      : { rowCount: 1, rows: [] },
  }),
  queue: { add: async (...args) => { queued = args; } },
});
assert.equal(callback.status, 'queued');
assert.equal(queued[0], 'store-recording');
assert.equal(queued[1].callId, callId);
assert.doesNotMatch(queued[2].jobId, /recording:id\/unsafe/);

const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from('test-recording')]);
let storedObject;
const updateQueries = [];
const processed = await processPlivoRecording(callId, {
  loadContext: async () => ({
    ...baseCall,
    recording_object_key: null,
    provider_metadata: { recording: {
      id: 'recording:id/unsafe', url: 'https://media.plivo.com/recording.mp3', durationMs: 1234,
    } },
  }),
  fetchImpl: async (_url, options) => {
    assert.match(options.headers.authorization, /^Basic /);
    return new Response(mp3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  },
  putObject: async (object) => { storedObject = object; },
  updateState: async (operation) => operation({
    query: async (sql, values) => { updateQueries.push({ sql, values }); return { rowCount: 1 }; },
  }),
});
assert.equal(processed.contentType, 'audio/mpeg');
assert.match(storedObject.key, /^recordings\/tenant-1\/workspace-1\//);
assert.doesNotMatch(storedObject.key, /:/);
assert.equal(storedObject.body.equals(mp3), true);
assert.equal(updateQueries.length, 2);

let playbackQuery;
const playback = await loadStoredCallRecording({
  role: 'COMPANY_DEVELOPER', tenantId: 'tenant-1', userId: 'user-1',
}, callId, {
  contextRunner: async (operation) => operation({ query: async (sql, values) => {
    playbackQuery = { sql, values };
    return { rowCount: 1, rows: [{
      id: callId, tenant_id: 'tenant-1', recording_object_key: storedObject.key,
    }] };
  } }),
  getObject: async ({ key }) => ({ key, body: mp3, contentType: 'audio/mpeg' }),
});
assert.equal(playback.body.equals(mp3), true);
assert.equal(playbackQuery.values[2], 'tenant-1');
assert.match(playbackQuery.sql, /tenant_id=\$3/);

console.log(JSON.stringify({ success: true, task: 'Plivo recording callback, B2 storage and tenant playback' }));
