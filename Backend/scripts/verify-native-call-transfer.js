import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
const { createCallTransferService, endTransferXml, failedTransferXml } = await import('../src/voice/call-transfer.service.js');
const { callTransferTool } = await import('../src/voice/tools/call-transfer-tool.js');
const { executeAgentTool } = await import('../src/voice/tools/tool-executor.service.js');
const { transferPlivoCall, stopPlivoCallStreams, hangupPlivoCall } = await import('../src/telephony/plivo.client.js');
const { createTransferRepository } = await import('../src/voice/call-transfer.repository.js');
const { encryptCredential, decryptCredential } = await import('../src/security/credential-crypto.js');
const call = { id: '11111111-1111-4111-8111-111111111111', tenantId: 'company-a', workspaceId: 'workspace-a',
  agentId: 'agent-a', providerCallId: '22222222-2222-4222-8222-222222222222' };
const token = 'test-provider-token-not-a-real-credential';
const authId = 'SATESTSUBACCOUNT';
function setup(mode = 'wait_and_return', overrides = {}) {
  const rows = new Map(); const operations = []; const runtimes = new Map(); let sequence = 0;
  const repository = {
    enabled: async () => true,
    async reserve(value) {
      assert.equal(value.tenantId, call.tenantId);
      const active = [...rows.values()].find(row => ['requested', 'ringing', 'bridged', 'resuming'].includes(row.state));
      if (active) return { attempt: { ...active }, duplicate: true };
      const row = { id: `transfer-${++sequence}`, call_id: value.id, tenant_id: value.tenantId,
        provider_call_id: value.providerCallId, state: 'requested', mode, destination_number: '+919000000002',
        caller_id: '+918000000001', ring_timeout_seconds: 25, auth_id: authId,
        auth_token_encrypted: encryptCredential(token), main_auth_token_encrypted: encryptCredential(token) };
      rows.set(row.id, row); return { attempt: { ...row }, duplicate: false };
    },
    get: async id => rows.has(id) ? { ...rows.get(id) } : null,
    saveResumeXml: async (id, response) => { const row = rows.get(id); row.resume_xml ??= response; return row.resume_xml; },
    async transition(id, states, next, fields = {}) {
      const row = rows.get(id); if (!row || !states.includes(row.state)) return null;
      row.state = next; if (fields.staffCallId) row.staff_call_id ??= fields.staffCallId;
      if (fields.result) row.result = fields.result;
      return { ...row };
    },
    async cancelCall(providerCallId) {
      return [...rows.values()].filter(row => row.provider_call_id === providerCallId
        && ['requested', 'ringing', 'bridged', 'resuming'].includes(row.state)).map(row => { row.state = 'canceled'; return { ...row }; });
    },
  };
  const history = [{ role: 'user', content: 'Patient Surya, Salem, leg pain' }];
  const runtime = { call, history, streamOpen: true,
    streamActive() { return this.streamOpen; },
    async pause() { operations.push('pause'); },
    async detach() { operations.push('detach'); this.streamOpen = false; },
    async restore(result) { operations.push(['restore', result]); },
    async bridged() { operations.push('bridged'); },
    async hangup() { operations.push('hangup'); },
  };
  const service = createCallTransferService({ enabled: true, publicBaseUrl: 'https://voice.example.com',
    repository, runtimes, decrypt: decryptCredential, ownership: { heartbeat: async () => true },
    logger: { info() {}, warn() {} },
    transfer: async (id, secret, uuid, url) => {
      assert.equal(id, authId); assert.equal(secret, token); assert.equal(uuid, call.providerCallId);
      operations.push(['transfer', url]); return { message: 'transfer executed' };
    },
    stopStreams: async () => { operations.push('stopStreams'); },
    hangup: async (id, secret, uuid) => { operations.push(['cancelStaff', uuid]); },
    buildStreamXml: value => { assert.equal(value, call); return '<Response><Stream>same-call</Stream></Response>'; },
    ...overrides,
  });
  service.register(runtime);
  function callback(action, payload, id = [...rows.keys()][0]) {
    const url = `https://voice.example.com/webhooks/plivo/transfer/${id}/${action}`;
    const nonce = 'provider-signed-nonce';
    const pairs = Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${key}${value}`).join('');
    const signature = createHmac('sha256', token).update(`${url}?${pairs}.${nonce}`).digest('base64');
    return { id, action, payload, nonce, signature };
  }
  return { service, runtime, rows, operations, callback, repository };
}

const s = setup();
assert.equal(await s.service.available(call), true);
const [first, duplicate] = await Promise.all([s.service.request(call), s.service.request(call)]);
assert.equal(first.success, true); assert.equal(duplicate.duplicate, true);
assert.equal(s.operations.filter(value => Array.isArray(value) && value[0] === 'transfer').length, 1);
assert.deepEqual(s.operations.slice(0, 3).map(value => Array.isArray(value) ? value[0] : value), ['pause', 'transfer', 'stopStreams']);
assert.equal(first.connected, false);
await assert.rejects(s.service.request({ ...call, tenantId: 'company-b' }), error => error.code === 'TRANSFER_RUNTIME_UNAVAILABLE');
const dial = s.callback('dial', { CallUUID: call.providerCallId });
await assert.rejects(s.service.callback({ ...dial, signature: 'forged' }), error => error.code === 'PLIVO_SIGNATURE_INVALID');
await assert.rejects(s.service.callback(s.callback('dial', { CallUUID: 'other-call' })), error => error.code === 'TRANSFER_CALL_MISMATCH');
assert.equal([...s.rows.values()][0].state, 'requested');
const dialXml = await s.service.callback(dial);
assert.match(dialXml, /timeout="25"/); assert.match(dialXml, /<Number>\+919000000002<\/Number>/);
assert.match(dialXml, /callerId="\+918000000001"/);
assert.match(dialXml, /dialMusic="https:\/\/voice.example.com\/webhooks\/plivo\/transfer-music"/);
assert.equal(s.operations.at(-1), 'detach');
assert.equal(s.runtime.history[0].content, 'Patient Surya, Salem, leg pain');
await s.service.callback(s.callback('events', { DialALegUUID: call.providerCallId,
  DialBLegUUID: 'staff-leg', DialAction: 'connected', DialBLegTo: '+919000000002' }));
assert.equal([...s.rows.values()][0].state, 'bridged');
assert.equal(s.operations.filter(value => value === 'bridged').length, 1);
await s.service.callback(s.callback('events', { DialALegUUID: call.providerCallId, DialBLegUUID: 'staff-leg', DialAction: 'connected' }));
assert.equal(s.operations.filter(value => value === 'bridged').length, 1);
assert.equal(await s.service.callback(s.callback('result', { DialALegUUID: call.providerCallId,
  DialBLegUUID: 'staff-leg', DialStatus: 'completed' })), endTransferXml);
assert.equal(s.runtime.resumeResult, undefined, 'Answered transfers never rejoin AI when staff later hang up');
s.service.unregister(call.id);

for (const status of ['busy', 'failed', 'cancel', 'timeout', 'no-answer']) {
  const f = setup(); await f.service.request(call);
  await f.service.callback(f.callback('dial', { CallUUID: call.providerCallId }));
  const response = await f.service.callback(f.callback('result', { DialALegUUID: call.providerCallId, DialStatus: status }));
  assert.match(response, /<Stream>same-call/); assert.equal(f.runtime.resumeResult.status, status);
  assert.equal(f.runtime.resumeResult.callbackSaved, false); assert.equal(f.runtime.resumeResult.connected, false);
  assert.equal(f.runtime.history[0].content, 'Patient Surya, Salem, leg pain');
  await f.service.resumed(call.id); assert.equal([...f.rows.values()][0].state, 'returned');
  assert.equal(await f.service.callback(f.callback('result', { DialALegUUID: call.providerCallId, DialStatus: status })), response,
    'A duplicate failure callback returns the same recovery XML instead of hanging up the caller');
  await f.service.callback(f.callback('events', { DialALegUUID: call.providerCallId,
    DialBLegUUID: 'late-answer-after-return', DialAction: 'answer' }));
  assert.deepEqual(f.operations.at(-1), ['cancelStaff', 'late-answer-after-return']);
  f.service.unregister(call.id);
}
for (const status of ['busy', 'failed', 'cancel', 'timeout', 'no-answer']) {
  const f = setup('direct_handoff'); await f.service.request(call);
  await f.service.callback(f.callback('dial', { CallUUID: call.providerCallId }));
  const input = f.callback('result', { DialALegUUID: call.providerCallId, DialStatus: status });
  const responses = await Promise.all([f.service.callback(input), f.service.callback(input)]);
  assert.deepEqual(responses, [failedTransferXml, failedTransferXml]);
  assert.equal(f.runtime.resumeResult, undefined); f.service.unregister(call.id);
}
const answeredDirect = setup('direct_handoff'); await answeredDirect.service.request(call);
await answeredDirect.service.callback(answeredDirect.callback('dial', { CallUUID: call.providerCallId }));
const connectedDirect = answeredDirect.callback('events', { DialALegUUID: call.providerCallId, DialBLegUUID: 'direct-staff', DialAction: 'connected' });
await Promise.all([answeredDirect.service.callback(connectedDirect), answeredDirect.service.callback(connectedDirect)]);
assert.equal(answeredDirect.operations.filter(value => value === 'bridged').length, 1);
await answeredDirect.service.callerHangup(call.providerCallId);
assert.deepEqual(answeredDirect.operations.at(-1), ['cancelStaff', 'direct-staff']);
answeredDirect.service.unregister(call.id);
const direct = setup('direct_handoff'); await direct.service.request(call);
assert.equal(await direct.service.callback(direct.callback('result', { DialALegUUID: call.providerCallId, DialStatus: 'busy' })), failedTransferXml);
assert.equal(direct.runtime.resumeResult, undefined); assert.match(failedTransferXml, /<Speak>.*<Hangup/);
assert.doesNotMatch(failedTransferXml, /call.*back|contact you/i); direct.service.unregister(call.id);

for (const mode of ['wait_and_return', 'direct_handoff']) {
const canceled = setup(mode); await canceled.service.request(call);
await canceled.service.callerHangup(call.providerCallId);
assert.equal(await canceled.service.callback(canceled.callback('dial', { CallUUID: call.providerCallId })), endTransferXml);
await canceled.service.callback(canceled.callback('events', { DialALegUUID: call.providerCallId, DialBLegUUID: 'late-staff-leg', DialAction: 'answer' }));
assert.deepEqual(canceled.operations.at(-1), ['cancelStaff', 'late-staff-leg']);
assert.equal(canceled.runtime.resumeResult, undefined); canceled.service.unregister(call.id);
}

for (const mode of ['wait_and_return', 'direct_handoff']) {
const rejected = setup(mode, { transfer: async () => {
  throw Object.assign(new Error('Rejected'), { details: { providerStatus: 401 } });
} });
assert.equal((await rejected.service.request(call)).success, false);
assert.equal(rejected.operations.at(-1)[0], 'restore');
assert.equal(rejected.operations.includes('stopStreams'), false, 'Rejected handoff must not stop caller media');
rejected.service.unregister(call.id);
}

const disabled = setup('wait_and_return', { enabled: false });
assert.equal(await disabled.service.available(call), false);
await assert.rejects(disabled.service.request(call), error => error.code === 'TRANSFER_DISABLED');
disabled.service.unregister(call.id);
const profile = { tools: [callTransferTool] };
const toolCall = { name: 'transfer_call', arguments: { callerConfirmed: true }, authorizationRecordId: callTransferTool.id };
await assert.rejects(executeAgentTool(profile, call, toolCall), error => error.code === 'TRANSFER_NOT_AUTHORIZED');
await assert.rejects(executeAgentTool(profile, call, { ...toolCall, arguments: { callerConfirmed: true, destination: '+919999999999' } }, {
  requireWorkflowAuthorization: true, workflowAuthorization: { recordId: callTransferTool.id, toolName: 'transfer_call' },
}), error => error.code === 'VOICE_TOOL_ARGUMENTS_INVALID');
let authorized = 0;
assert.equal((await executeAgentTool(profile, call, toolCall, { requireWorkflowAuthorization: true,
  workflowAuthorization: { recordId: callTransferTool.id, toolName: 'transfer_call' },
  callTransferService: { request: async () => { authorized++; return { success: true }; } },
})).success, true);
assert.equal(authorized, 1);

// Exercise the real HTTP adapter without making paid calls.
const requests = [];
const fetchImpl = async (url, options) => { requests.push({ url, options }); return { ok: true, status: options.method === 'DELETE' ? 204 : 202,
  json: async () => ({ message: 'call transferred' }) }; };
await transferPlivoCall(authId, token, call.providerCallId, 'https://voice.example.com/dial', fetchImpl);
await stopPlivoCallStreams(authId, token, call.providerCallId, fetchImpl);
await hangupPlivoCall(authId, token, 'staff-leg', fetchImpl);
assert.equal(requests[0].options.headers.authorization, `Basic ${Buffer.from(`${authId}:${token}`).toString('base64')}`);
assert.deepEqual(JSON.parse(requests[0].options.body), { legs: 'aleg', aleg_url: 'https://voice.example.com/dial', aleg_method: 'POST' });
assert.match(requests[1].url, /\/Stream\/$/); assert.equal(requests[1].options.method, 'DELETE');
assert.match(requests[2].url, /\/Call\/staff-leg\/$/);

// Ensure repository authority comes from the active caller row and account, not tool arguments.
const queries = [];
const repo = createTransferRepository(async (_, op) => op({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; } }));
assert.equal(await repo.enabled(call), false);
assert.match(queries[0].sql, /a\.id=c\.telephony_account_id/);
assert.match(queries[0].sql, /a\.tenant_id=c\.tenant_id/);
assert.match(queries[0].sql, /s\.workspace_id=c\.workspace_id/);
assert.match(queries[0].sql, /c\.ended_at IS NULL/);
let disabledReads = 0;
const off = createCallTransferService({ enabled: false, repository: { enabled: async () => { disabledReads++; return true; } } });
assert.equal(await off.available(call), false); assert.equal(disabledReads, 0, 'Default-off execution must not require the new DB table');
const migration = await import('../migrations/1792100001000_call-transfer-attempts.js');
let sql = ''; await migration.up({ sql: value => { sql += value; } });
assert.match(sql, /CREATE UNIQUE INDEX call_transfer_one_active/);
assert.match(sql, /FORCE ROW LEVEL SECURITY/); assert.match(sql, /zea_is_platform_admin\(\)/);
console.log('Native transfer checks passed: workflow authorization, account scoping, API order, concurrent duplicate prevention, real callback signatures, staff bridge, five failure results, same-call context retention, direct fallback, late-leg cancellation and HTTP adapter. Provider/DB calls are mocked; no live phone calls were made.');
