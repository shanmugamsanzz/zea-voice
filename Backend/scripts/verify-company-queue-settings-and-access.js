import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'silent';
process.env.VOICE_COMPANY_QUEUE_ENABLED = 'true';
process.env.VOICE_COMPANY_QUEUE_TENANT_IDS = '';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= 'localhost';
const { getCompanyQueue, cancelCompanyQueuedTask } = await import('../src/queues/company-queue.service.js');
const { assertOutboundQueueSpace } = await import('../src/queues/outbound-queue-capacity.service.js');
const { updateCompanySchema } = await import('../src/companies/company.schemas.js');
const { requireRoles, requireSessionAuthentication } = await import('../src/auth/auth.middleware.js');
const now = Date.now();
const auth = { tenantId: 'company-a', workspaceId: 'workspace-a', userId: 'user', role: 'COMPANY_USER' };
const filters = { page: 1, pageSize: 50 };
const queryLog = [];
const dependencies = {
  now: () => now,
  redis: { status: 'ready', eval: async (_script, count, ...args) => {
    assert.equal(count, 8);
    assert.ok(args.slice(0, count).every(key => key.includes('{company-a}')));
    return [1, 1, ['call'], ['{}'], ['waiting-call'], [JSON.stringify({ phone: '+919123456789', agentName: 'Inbound agent', arrivedAt: now - 12000 })]];
  } },
  contextRunner: async operation => operation({ query: async (sql, values) => {
    queryLog.push({ sql, values });
    assert.equal(values[0], auth.tenantId);
    if (sql.includes('FROM tenant_limits')) return { rowCount: 1, rows: [{ max_total_concurrency: 3,
      max_inbound_queue_size: 2, max_inbound_wait_seconds: 30, max_outbound_queued_tasks: 100 }] };
    if (sql.includes('count(*)::int count')) return { rows: [{ count: 2 }] };
    if (sql.includes('FROM call_sessions')) return { rows: [{ id: 'session', provider_call_id: 'call',
      direction: 'outbound', status: 'connected', to_number: '+919222222222', agent_name: 'Agent',
      campaign_name: 'Campaign', started_at: new Date(now - 20000) }] };
    return { rows: [{ id: 'task', lead_phone: '+919333333333', source: 'batch',
      agent_name: 'Campaign agent', campaign_name: 'Campaign', campaign_status: 'running',
      scheduled_for: new Date(now - 1000), waiting_since: new Date(now - 15000), queue_reason: 'company_capacity' }] };
  } }),
};
const report = await getCompanyQueue(auth, filters, dependencies);
assert.deepEqual(report.totals, { active: 1, inboundWaiting: 1, outboundWaiting: 2 });
assert.equal(report.settings.maxInboundQueueSize, 2);
assert.equal(report.inbound[0].waitSeconds, 12);
assert.equal(report.active[0].agentName, 'Agent');
assert.equal(report.active[0].campaignName, 'Campaign');
assert.equal(report.active[0].durationSeconds, 20);
assert.equal(report.outbound[0].reason, 'company_capacity');
assert.equal(report.permissions.canManage, false);
assert.ok(queryLog.every(({ sql }) => sql.includes('tenant_id=$1') || sql.includes('c.tenant_id=$1') || sql.includes('t.tenant_id=$1')));
assert.equal((await getCompanyQueue({ ...auth, role: 'COMPANY_DEVELOPER' }, filters, dependencies)).permissions.canManage, true);
await assert.rejects(getCompanyQueue({ role: 'COMPANY_USER' }, filters, dependencies), e => e.code === 'TENANT_CONTEXT_REQUIRED');
await assert.rejects(getCompanyQueue(auth, filters, {
  ...dependencies, redis: { status: 'ready', eval: async () => { throw new Error('Redis connection closed'); } },
}), e => e.code === 'VOICE_COORDINATION_UNAVAILABLE' && e.statusCode === 503);
await assert.rejects(cancelCompanyQueuedTask(auth, 'other-task', {}), e => e.code === 'FORBIDDEN');

const developer = { ...auth, role: 'COMPANY_DEVELOPER' };
let writes = 0;
assert.equal((await cancelCompanyQueuedTask(developer, 'task', { contextRunner: async operation => operation({ query: async (sql, values) => {
  writes++;
  if (sql.startsWith('UPDATE campaign_tasks')) {
    assert.equal(values[1], auth.tenantId); assert.match(sql, /status='queued'/); assert.match(sql, /NOT EXISTS/);
    return { rowCount: 1, rows: [{ id: 'task', campaign_id: 'campaign' }] };
  }
  return { rows: [] };
} }) })).status, 'canceled');
assert.equal(writes, 3);
await assert.rejects(cancelCompanyQueuedTask(developer, 'foreign-or-active', {
  contextRunner: async operation => operation({ query: async () => ({ rowCount: 0, rows: [] }) }),
}), e => e.code === 'QUEUE_TASK_NOT_CANCELABLE');

for (const role of ['COMPANY_USER', 'COMPANY_DEVELOPER', 'SUPER_ADMIN']) {
  let error;
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER')({ auth: { role } }, {}, e => { error = e; });
  assert.equal(error?.code, role === 'COMPANY_USER' ? 'FORBIDDEN' : undefined);
  requireRoles('SUPER_ADMIN')({ auth: { role } }, {}, e => { error = e; });
  assert.equal(error?.code, role === 'SUPER_ADMIN' ? undefined : 'FORBIDDEN');
}
let sessionError;
requireSessionAuthentication({ auth: { authType: 'api_key' } }, {}, e => { sessionError = e; });
assert.equal(sessionError.code, 'SESSION_REQUIRED');

const partial = updateCompanySchema.parse({ limits: { maxInboundQueueSize: 5 } });
assert.deepEqual(partial.limits, { maxInboundQueueSize: 5 });
assert.equal(updateCompanySchema.safeParse({ limits: { maxInboundWaitSeconds: 1 } }).success, false);
assert.equal(updateCompanySchema.safeParse({ limits: { maxOutboundQueuedTasks: 0 } }).success, false);
let lockSeen = false;
const queueClient = { query: async (sql, values) => {
  assert.equal(values[0], auth.tenantId);
  if (sql.includes('tenant_limits')) { assert.match(sql, /FOR UPDATE/); lockSeen = true; return { rowCount: 1, rows: [{ max_outbound_queued_tasks: 3 }] }; }
  assert.equal(lockSeen, true); return { rows: [{ count: 2 }] };
} };
await assertOutboundQueueSpace(queueClient, auth.tenantId, 1);
await assert.rejects(assertOutboundQueueSpace(queueClient, auth.tenantId, 2), e => e.code === 'COMPANY_OUTBOUND_QUEUE_FULL' && e.details.available === 1);
const migration = await readFile(new URL('../migrations/1791269000000_company-queue-settings.js', import.meta.url), 'utf8');
assert.match(migration, /max_inbound_queue_size/); assert.match(migration, /max_outbound_queued_tasks/);
const routes = await readFile(new URL('../src/queues/company-queue.routes.js', import.meta.url), 'utf8');
assert.match(routes, /requireTenantContext/); assert.match(routes, /\.strict\(\)/);
assert.match(routes, /\/tasks\/:taskId\/cancel', developers/);
console.log('Company queue settings, scoped visibility, role restrictions, cancellation races and outbound limits verified.');
