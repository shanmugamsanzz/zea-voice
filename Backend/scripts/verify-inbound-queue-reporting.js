import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
const { recordInboundQueue, finishInboundQueueRow } = await import('../src/voice/inbound-queue-report.service.js');
const { createVoiceCallSession } = await import('../src/voice/call-session-store.js');
const agent = { tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', agentName: 'Test' };
const call = { capacityTenantId: agent.tenantId, telephonyAccountId: 'account-a', providerCallId: 'provider-a',
  phoneNumberId: 'phone-a', from: '+919000000001', to: '+918000000001', direction: 'inbound' };
let row; let inserts = 0; let creditReservations = 0;
const client = { async query(sql, values) {
  if (sql.includes('pg_advisory')) return { rows: [], rowCount: 1 };
  if (sql.includes('SELECT * FROM call_sessions')) return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
  if (sql.includes('INSERT INTO call_sessions')) {
    inserts++;
    row = { id: 'call-a', tenant_id: values[0], workspace_id: values[1], telephony_account_id: values[2],
      provider_call_id: values[4], agent_id: values[5], from_number: values[7], to_number: values[8],
      direction: 'inbound', status: 'queued', answered_at: null, ended_at: null, duration_seconds: 0,
      provider_metadata: { source: 'plivo-answer', inboundQueue: { state: 'waiting', arrivedAt: '2026-10-21T00:00:00Z', waitSeconds: 0 } } };
    return { rows: [structuredClone(row)], rowCount: 1 };
  }
  if (sql.includes("SET status='connected'")) {
    if (row.ended_at) return { rows: [], rowCount: 0 };
    if (sql.includes('reserved_credits=$2')) {
      row.reserved_credits = values[1];
      row.provider_metadata = { ...row.provider_metadata, ...JSON.parse(values[3]),
        inboundQueue: { ...row.provider_metadata.inboundQueue, state: 'admitted', waitSeconds: 20 } };
    }
    row.status = 'connected'; row.answered_at = '2026-10-21T00:00:20Z';
    return { rows: [structuredClone(row)], rowCount: 1 };
  }
  if (sql.includes('UPDATE call_sessions SET status=$3')) {
    assert.equal(values[1], row.tenant_id, 'terminal writes must be tenant-scoped');
    if (row.status !== 'queued' || row.ended_at || row.answered_at) return { rows: [], rowCount: 0 };
    row.status = values[2]; row.ended_at = '2026-10-21T00:00:20Z'; row.duration_seconds = 0;
    row.provider_metadata.inboundQueue = { ...row.provider_metadata.inboundQueue,
      state: values[3], outcome: values[4], waitSeconds: 20 };
    return { rows: [structuredClone(row)], rowCount: 1 };
  }
  throw new Error(`Unexpected SQL: ${sql}`);
} };
const dependencies = { contextRunner: operation => operation(client) };
const input = { call, agent, admission: { status: 'waiting' } };
await recordInboundQueue(input, dependencies);
await recordInboundQueue(input, dependencies);
assert.equal(inserts, 1, 'polls must not duplicate calls');
assert.equal(row.answered_at, null);
assert.equal(row.duration_seconds, 0);
await assert.rejects(recordInboundQueue({ ...input, agent: { ...agent, tenantId: 'tenant-b' } }, dependencies),
  error => error.code === 'INBOUND_QUEUE_SCOPE_MISMATCH');
await assert.rejects(recordInboundQueue({ ...input, agent: { ...agent, workspaceId: 'workspace-b' } }, dependencies),
  error => error.code === 'INBOUND_QUEUE_SCOPE_MISMATCH');
await finishInboundQueueRow(client, structuredClone(row), 'caller_left');
assert.equal(row.provider_metadata.inboundQueue.outcome, 'Caller left waiting queue');
assert.equal(row.status, 'canceled');
await recordInboundQueue({ ...input, admission: { status: 'ended' } }, dependencies);
assert.equal(row.provider_metadata.inboundQueue.state, 'caller_left', 'timeout retry must not overwrite hangup');
const terminal = structuredClone(row);
await finishInboundQueueRow(client, terminal, 'expired');
assert.deepEqual(row, terminal);
row = undefined;
await recordInboundQueue(input, dependencies);
await recordInboundQueue({ ...input, admission: { status: 'ended' } }, dependencies);
assert.equal(row.provider_metadata.inboundQueue.outcome, 'Waiting time expired');
await finishInboundQueueRow(client, structuredClone(row), 'caller_left');
assert.equal(row.provider_metadata.inboundQueue.state, 'expired', 'provider hangup preserves timeout');
assert.equal(row.answered_at, null);
assert.equal(row.duration_seconds, 0);
row = undefined;
await recordInboundQueue(input, dependencies);
const runtimeProfile = { agent: { tenantId: agent.tenantId, workspaceId: agent.workspaceId, id: agent.agentId },
  providers: Object.fromEntries(['stt','tts','llm'].map(k => [k, { providerId: `${k}-provider`, modelId: `${k}-model` }])) };
const sessionDeps = { ...dependencies, reserveCredit: async () => {
  creditReservations++; return { reservedCredits: 1, priceSnapshotInr: null };
} };
const beforeAdmissionInserts = inserts;
const promoted = await createVoiceCallSession({ call, runtimeProfile }, sessionDeps);
assert.equal(promoted.id, 'call-a');
assert.equal(row.status, 'connected');
assert.equal(row.provider_metadata.inboundQueue.state, 'admitted');
assert.equal(row.provider_metadata.sttProviderId, 'stt-provider');
await createVoiceCallSession({ call, runtimeProfile }, sessionDeps);
assert.equal(creditReservations, 1, 'duplicate admission must not reserve credit again');
assert.equal(inserts, beforeAdmissionInserts);
await finishInboundQueueRow(client, structuredClone(row), 'caller_left');
assert.equal(row.status, 'connected', 'queue hangup handler must not alter an admitted call');
await assert.rejects(finishInboundQueueRow(client, row, 'invalid'));
row.status = 'canceled'; row.ended_at = '2026-10-21T00:00:30Z';
await assert.rejects(createVoiceCallSession({ call, runtimeProfile }, sessionDeps),
  error => error.code === 'VOICE_CALL_ALREADY_ENDED');
console.log(JSON.stringify({ suite: 'inbound-queue-reporting', passed: true }));
