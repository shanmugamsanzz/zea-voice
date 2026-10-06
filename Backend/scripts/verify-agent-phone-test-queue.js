import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'silent';
process.env.VOICE_COMPANY_QUEUE_ENABLED = 'true'; process.env.VOICE_COMPANY_QUEUE_TENANT_IDS = '';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test'; process.env.REDIS_HOST ??= 'localhost';
const { startAgentPhoneTest } = await import('../src/agents/agent-phone-test.service.js');
const { processQueuedPhoneTest, cancelCompanyPhoneTest } = await import('../src/agents/agent-phone-test-queue.service.js');
const auth = { tenantId: 'company-a', workspaceId: 'workspace-a', userId: 'developer', role: 'COMPANY_DEVELOPER' };
const other = { ...auth, tenantId: 'company-b', workspaceId: 'workspace-b' };
const rows = new Map(), slots = new Map(), dials = [];
let credits = true, rejectProvider = false, failInsert = false, failSave = false, campaignWaiting = 0;
let transaction = Promise.resolve();
let shareValid = true;
const account = { status: 'active', name: 'Family Assistant', usage_direction: 'both', e164: '+918065587447',
  account_status: 'connected', answer_url: 'https://example.com/answer', hangup_url: 'https://example.com/hangup',
  auth_id: 'account', auth_token_encrypted: 'encrypted', max_total_concurrency: 2 };
const active = tenant => { if (!slots.has(tenant)) slots.set(tenant, new Set()); return slots.get(tenant); };
const waiting = tenant => [...rows.values()].filter(row => row.tenant_id === tenant && row.status === 'queued');
async function query(sql, v) {
  if (sql.includes('SELECT l.* FROM phone_test_share_links')) return { rowCount: shareValid ? 1 : 0, rows: shareValid ? [{}] : [] };
  if (sql.includes('FROM voice_agents')) return { rowCount: 1, rows: [account] };
  if (sql.includes('FROM tenant_limits')) return { rowCount: 1, rows: [{ max_outbound_queued_tasks: 2 }] };
  if (sql.includes('count(*)::int count')) {
    assert.match(sql, /UNION ALL SELECT id FROM agent_phone_test_requests/);
    return { rows: [{ count: waiting(v[0]).length + campaignWaiting }] };
  }
  if (sql.includes('SELECT tenant_id FROM agent_phone_test_requests')) {
    const row = rows.get(v[0]); return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
  }
  if (sql.includes('SELECT * FROM agent_phone_test_requests')) {
    const row = sql.includes('request_key')
      ? [...rows.values()].find(r => r.tenant_id === v[0] && r.workspace_id === v[1] && r.request_key === v[2])
      : [...rows.values()].find(r => r.id === v[0] && r.tenant_id === v[1]);
    return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('SELECT id FROM agent_phone_test_requests')) {
    const row = waiting(v[0])[0]; return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('INSERT INTO agent_phone_test_requests')) {
    if (failInsert) throw new Error('database insert failed');
    const [id, tenant_id, workspace_id, agent_id, created_by, request_key, phone, status, queue_reason, share_link_id] = v;
    const row = { id, tenant_id, workspace_id, agent_id, created_by, request_key, phone, status, queue_reason, share_link_id };
    rows.set(id, row); return { rowCount: 1, rows: [{ ...row }] };
  }
  if (sql.startsWith('UPDATE agent_phone_test_requests')) {
    const row = rows.get(v[0]);
    if (sql.includes("SET status='canceled'")) {
      if (!row || row.tenant_id !== v[1] || row.status !== 'queued') return { rowCount: 0, rows: [] };
      row.status = 'canceled'; return { rowCount: 1, rows: [{ id: row.id }] };
    }
    assert.ok(row);
    if (sql.includes("SET status='dispatching'")) row.status = 'dispatching';
    if (sql.includes("SET status='initiated'")) {
      if (failSave) throw new Error('accepted dispatch save failed');
      row.status = 'initiated'; row.provider_request_id = v[2];
    }
    if (sql.includes("queue_reason='waiting_credits'")) row.queue_reason = 'waiting_credits';
    if (sql.includes('queue_reason=$2')) row.queue_reason = v[1];
    if (sql.includes("SET status='failed'")) row.status = 'failed';
    return { rowCount: 1, rows: [] };
  }
  if (sql.startsWith('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
  throw new Error(`Unexpected SQL: ${sql}`);
}
const contextRunner = (_user, operation) => {
  const result = transaction.then(async () => {
    const snapshot = new Map([...rows].map(([id, row]) => [id, { ...row }]));
    try { return await operation({ query }); }
    catch (error) { rows.clear(); for (const [id, row] of snapshot) rows.set(id, row); throw error; }
  });
  transaction = result.catch(() => {}); return result;
};
const deps = { contextRunner, validateModels: async () => {}, decrypt: () => 'secret',
  checkCredits: async () => { if (!credits) throw Object.assign(new Error('No credits'), { code: 'COMPANY_CREDITS_EXHAUSTED', statusCode: 409 }); },
  ownership: { acquire: async ({ tenantId, providerCallId, limit }) => {
    if (active(tenantId).size >= limit) throw Object.assign(new Error('Company full'), { code: 'VOICE_COMPANY_CONCURRENCY_LIMIT' });
    active(tenantId).add(providerCallId); assert.ok(active(tenantId).size <= 2);
  }, releaseReservation: async ({ tenantId, reservationId }) => active(tenantId).delete(reservationId) },
  makeCall: async (_id, _token, input) => {
    if (rejectProvider) throw Object.assign(new Error('Provider rejected'), { code: 'PROVIDER_REJECTED' });
    dials.push(new URL(input.answerUrl).searchParams.get('capacity_id')); return { requestUuid: `provider-${dials.length}` };
  },
};
const inputs = Array.from({ length: 8 }, (_, i) => ({ phone: `+91912345678${i}`, requestId: randomUUID() }));
const submit = (i, who = auth) => startAgentPhoneTest(who, 'agent', inputs[i], deps);
const first = await submit(0), second = await submit(1), third = await submit(2), fourth = await submit(3);
assert.equal(first.status, 'initiated'); assert.equal(second.status, 'initiated');
assert.equal(third.status, 'queued'); assert.equal(fourth.status, 'queued'); assert.equal(dials.length, 2);
await assert.rejects(submit(4), e => e.code === 'COMPANY_OUTBOUND_QUEUE_FULL');
assert.equal((await submit(2)).id, third.id); assert.equal(dials.length, 2);
await assert.rejects(startAgentPhoneTest(auth, 'agent', { ...inputs[2], phone: '+919999999999' }, deps), e => e.code === 'PHONE_TEST_REQUEST_CONFLICT');
assert.equal((await submit(2, other)).status, 'initiated'); assert.equal(dials.length, 3);
active(auth.tenantId).delete(first.id);
await Promise.all([processQueuedPhoneTest(third.id, { ...deps }), processQueuedPhoneTest(third.id, { ...deps })]);
assert.equal(dials.length, 4); assert.equal(rows.get(third.id).status, 'initiated');
active(auth.tenantId).delete(second.id); credits = false;
await processQueuedPhoneTest(fourth.id, deps);
assert.equal(rows.get(fourth.id).status, 'queued'); assert.equal(rows.get(fourth.id).queue_reason, 'waiting_credits');
assert.equal(dials.length, 4); credits = true;
await processQueuedPhoneTest(fourth.id, { ...deps }); assert.equal(dials.length, 5);
const cancel = await submit(4);
await assert.rejects(cancelCompanyPhoneTest({ ...auth, role: 'COMPANY_USER' }, cancel.id), e => e.code === 'FORBIDDEN');
await assert.rejects(cancelCompanyPhoneTest(other, cancel.id, { tenantContextRunner: op => contextRunner(other.userId, op) }), e => e.code === 'QUEUE_TASK_NOT_CANCELABLE');
await cancelCompanyPhoneTest(auth, cancel.id, { tenantContextRunner: op => contextRunner(auth.userId, op) });
await processQueuedPhoneTest(cancel.id, deps); assert.equal(dials.length, 5);
campaignWaiting = 2;
await assert.rejects(submit(5), e => e.code === 'COMPANY_OUTBOUND_QUEUE_FULL'); campaignWaiting = 0;
active(auth.tenantId).delete(third.id); failInsert = true;
await assert.rejects(submit(5), /database insert failed/); assert.equal(active(auth.tenantId).size, 1); failInsert = false;
rejectProvider = true; assert.equal((await submit(5)).status, 'failed');
assert.equal(active(auth.tenantId).size, 1); rejectProvider = false;
failSave = true; await assert.rejects(submit(6), /accepted dispatch save failed/); failSave = false;
const count = dials.length;
assert.equal((await submit(6)).status, 'dispatching');
await processQueuedPhoneTest(dials.at(-1), deps); assert.equal(dials.length, count);
const shared = await startAgentPhoneTest(auth,'agent',{...inputs[7],shareLinkId:randomUUID()},deps);
assert.equal(shared.status,'queued'); shareValid = false;
await processQueuedPhoneTest(shared.id,deps);
assert.equal(rows.get(shared.id).status,'failed'); assert.equal(dials.length,count);
console.log('Phone-test queue verified: 2 active / 2 waiting, campaign bounds, dispatch, duplicates, credits, reconstructed workers, rollback, ambiguous dispatch and company/role isolation.');
