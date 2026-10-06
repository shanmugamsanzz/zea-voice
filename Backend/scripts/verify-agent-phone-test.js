import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= 'localhost';
const { startAgentPhoneTest } = await import('../src/agents/agent-phone-test.service.js');
const auth = { userId: 'user', tenantId: 'tenant', workspaceId: 'workspace' };
let row = { status: 'active', usage_direction: 'both', e164: '+918065587447', account_status: 'connected',
  answer_url: 'https://example.com/answer', hangup_url: 'https://example.com/hangup',
  auth_id: 'account', auth_token_encrypted: 'encrypted', max_total_concurrency: 50 };
let active = 0;
let calls = 0;
const dependencies = {
  contextRunner: async (userId, operation) => {
    assert.equal(userId, auth.userId);
    return operation({ query: async (sql, values) => {
      if (sql.includes('FROM voice_agents')) {
        assert.deepEqual(values, ['agent', 'tenant', 'workspace']);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      return { rows: [{ count: active }] };
    } });
  },
  validateModels: async () => {}, checkCredits: async () => {}, decrypt: () => 'secret',
  ownership: {
    acquire: async ({ tenantId, limit }) => {
      assert.equal(tenantId, auth.tenantId);
      assert.equal(limit, row.max_total_concurrency);
      if (active >= limit) throw Object.assign(new Error('Capacity full'), { code: 'VOICE_COMPANY_CONCURRENCY_LIMIT' });
    },
    releaseReservation: async () => {},
  },
  makeCall: async (id, token, input) => {
    calls++;
    assert.equal(id, 'account'); assert.equal(token, 'secret');
    assert.equal(input.from, '+918065587447'); assert.equal(input.to, '+919876543210');
    const answer = new URL(input.answerUrl);
    const hangup = new URL(input.hangupUrl);
    assert.ok(answer.searchParams.get('capacity_id'));
    assert.equal(answer.searchParams.get('capacity_id'), hangup.searchParams.get('capacity_id'));
    assert.equal(input.ringTimeoutSeconds, 120);
    return { requestUuid: 'request' };
  },
};
assert.equal((await startAgentPhoneTest(auth, 'agent', { phone: '+919876543210' }, dependencies)).status, 'initiated');
await assert.rejects(startAgentPhoneTest(auth, 'agent', { phone: 'invalid' }, dependencies),
  (e) => e.code === 'PHONE_TEST_INVALID_NUMBER');
active = 50;
await assert.rejects(startAgentPhoneTest(auth, 'agent', { phone: '+919876543210' }, dependencies),
  (e) => e.code === 'VOICE_COMPANY_CONCURRENCY_LIMIT');
active = 0; row.usage_direction = 'inbound';
await assert.rejects(startAgentPhoneTest(auth, 'agent', { phone: '+919876543210' }, dependencies),
  (e) => e.code === 'PHONE_TEST_DIRECTION_UNAVAILABLE');
row = null;
await assert.rejects(startAgentPhoneTest(auth, 'agent', { phone: '+919876543210' }, dependencies),
  (e) => e.code === 'PHONE_TEST_AGENT_NOT_FOUND');
assert.equal(calls, 1);
console.log('Agent phone-call tests passed.');
