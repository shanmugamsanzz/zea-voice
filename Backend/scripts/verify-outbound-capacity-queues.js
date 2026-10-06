import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.PUBLIC_BASE_URL = 'https://example.com';
const { executeCampaignTask } = await import('../src/campaigns/campaign-execution.service.js');
const { processCampaignQueueJob } = await import('../src/campaigns/campaign.workers.js');
const live = process.argv.includes('--redis');
const tenantId = `outbound-release-test-${randomUUID()}`;
let testRedis, realOwnership;
if (live) {
  const { Redis } = await import('ioredis');
  const { VoiceCallOwnership } = await import('../src/voice/call-ownership.service.js');
  testRedis = new Redis({ host: '127.0.0.1', port: Number(process.env.CAPACITY_TEST_REDIS_PORT ?? 6379),
    lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  await testRedis.connect();
  realOwnership = new VoiceCallOwnership({ redis: testRedis, instanceId: 'outbound-release-test' });
}
const now = Date.now();
const tasks = new Map(Array.from({ length: 100 }, (_, i) => [`task-${i}`, {
  id: `task-${i}`, tenant_id: tenantId, workspace_id: 'workspace', campaign_id: 'campaign',
  source: i % 2 ? 'realtime' : 'batch', campaign_status: 'running', status: 'queued',
  available_credits: 100, low_credit_threshold: 1, max_total_concurrency: 3, concurrency_limit: 20,
  retry_count: 0, scheduled_for: new Date(now - 1000),
  answer_url: 'https://example.com/answer', hangup_url: 'https://example.com/hangup',
}]));
const slots = new Set();
const reservations = new Map();
try {
let inserts = 0, credits = 0, dials = 0, peakSlots = 0;
const ownership = {
  acquire: async input => {
    const { providerCallId, limit } = input;
    if (realOwnership) await realOwnership.acquire(input);
    if (slots.size >= limit) throw Object.assign(new Error('full'), { code: 'VOICE_COMPANY_CONCURRENCY_LIMIT' });
    slots.add(providerCallId);
    peakSlots = Math.max(peakSlots, slots.size);
  },
  releaseReservation: async ({ reservationId }) => {
    if (realOwnership) await realOwnership.releaseReservation({ tenantId, reservationId });
    return slots.delete(reservationId);
  },
};
// Serialize transactions to model the existing wallet/advisory row locks.
let transaction = Promise.resolve();
const contextRunner = operation => {
  const result = transaction.then(() => operation({ query: async (sql, values) => {
    if (sql.includes('SELECT t.*')) return { rowCount: 1, rows: [tasks.get(values[0])] };
    if (sql.includes('AS allowed')) return { rows: [{ allowed: true }] };
    if (sql.includes('AS campaign_active')) return { rows: [{ campaign_active:
      [...tasks.values()].filter(t => t.status === 'running').length }] };
    if (sql.includes('INSERT INTO campaign_task_attempts')) {
      inserts++; return { rows: [{ id: `attempt-${values[1]}` }] };
    }
    if (sql.includes('INSERT INTO call_sessions')) {
      reservations.set(JSON.parse(values[10]).taskId, JSON.parse(values[10]).capacityReservationId);
      return { rows: [{ id: `call-${inserts}` }] };
    }
    if (sql.includes("SET status='running',queue_reason")) tasks.get(values[0]).status = 'running';
    if (sql.includes("queue_reason='waiting_credits'")) tasks.get(values[0]).queue_reason = 'waiting_credits';
    if (sql.includes("queue_reason='campaign_paused'")) tasks.get(values[0]).queue_reason = 'campaign_paused';
    return { rowCount: 1, rows: [] };
  } }));
  transaction = result.catch(() => {}); return result;
};
const deferred = [];
const dependencies = { ownership, contextRunner, now: () => now, decrypt: () => 'secret',
  reserveCredit: async () => { credits++; return { reservedCredits: 1, priceSnapshotInr: 1 }; },
  makeCall: async () => { dials++; return { requestUuid: `request-${dials}` }; },
  deferTask: async (task, delay) => deferred.push({ id: task.id, delay }),
};
const results = await Promise.all([...tasks.keys()].map(id => executeCampaignTask(id, dependencies)));
assert.equal(results.filter(r => r.action === 'started').length, 3);
assert.equal(results.filter(r => r.action === 'deferred').length, 97);
assert.equal(dials, 3); assert.equal(inserts, 3); assert.equal(credits, 3);
assert.equal([...tasks.values()].filter(t => t.status === 'queued').length, 97);
assert.ok([...tasks.values()].every(t => t.retry_count === 0));
const started = [...tasks.values()].find(t => t.status === 'running');
await ownership.releaseReservation({ reservationId: reservations.get(started.id) });
started.status = 'completed';
const waiting = [...tasks.values()].find(t => t.status === 'queued');
assert.equal((await executeCampaignTask(waiting.id, dependencies)).action, 'started');
assert.equal(dials, 4);
assert.equal((await executeCampaignTask(waiting.id, dependencies)).action, 'ignored');
assert.equal(dials, 4);

const scheduled = [...tasks.values()].find(t => t.status === 'queued');
scheduled.scheduled_for = new Date(now + 60000);
assert.equal((await executeCampaignTask(scheduled.id, dependencies)).reason, 'scheduled');
assert.equal(deferred.at(-1).delay, 60000); assert.equal(dials, 4);
scheduled.scheduled_for = new Date(now - 1000);
scheduled.available_credits = 0;
const beforeDefers = deferred.length;
assert.equal((await executeCampaignTask(scheduled.id, dependencies)).reason, 'waiting_credits');
assert.equal(deferred.length, beforeDefers);
scheduled.available_credits = 100; scheduled.campaign_status = 'paused';
assert.equal((await executeCampaignTask(scheduled.id, dependencies)).reason, 'campaign_paused');
assert.equal(deferred.length, beforeDefers);
scheduled.campaign_status = 'running'; scheduled.concurrency_limit = 1;
assert.equal((await executeCampaignTask(scheduled.id, dependencies)).reason, 'concurrency');
assert.equal(dials, 4); assert.equal(credits, 4); assert.equal(inserts, 4);

scheduled.concurrency_limit = 20;
const unavailable = await executeCampaignTask(scheduled.id, { ...dependencies,
  ownership: { acquire: async () => { throw Object.assign(new Error('redis unavailable'),
    { code: 'VOICE_COORDINATION_UNAVAILABLE' }); } },
});
assert.equal(unavailable.reason, 'coordination_unavailable');
assert.equal(scheduled.status, 'queued'); assert.equal(dials, 4);

for (const queueName of ['batch-calls', 'realtime-calls', 'call-retries']) {
  let moved;
  const job = { data: { taskId: 'waiting' }, queueName, attemptsMade: 0,
    moveToDelayed: async (timestamp, token) => { moved = { timestamp, token }; } };
  await assert.rejects(processCampaignQueueJob(job, 'worker-lock', {
    now: () => now, executeTask: async (id, deps) => {
      assert.equal(id, 'waiting'); await deps.deferTask({}, 5000);
    },
  }), e => e.name === 'DelayedError');
  assert.deepEqual(moved, { timestamp: now + 5000, token: 'worker-lock' });
  assert.equal(job.attemptsMade, 0); assert.equal(job.queueName, queueName);
}
// Drain all 100 tasks in waves. Simulate workers being recreated between waves
// while the persistent queue/task state and shared capacity stay intact.
while ([...tasks.values()].some(task => task.status === 'running' || task.status === 'queued')) {
  for (const task of tasks.values()) if (task.status === 'running') {
    await ownership.releaseReservation({ reservationId: reservations.get(task.id) });
    await ownership.releaseReservation({ reservationId: reservations.get(task.id) });
    task.status = 'completed';
    assert.equal((await executeCampaignTask(task.id, { ...dependencies })).action, 'ignored');
  }
  const pending = [...tasks.values()].filter(task => task.status === 'queued');
  if (pending.length) await Promise.all(pending.map(task => executeCampaignTask(task.id, { ...dependencies })));
}
assert.equal(peakSlots, 3); assert.equal(dials, 100); assert.equal(credits, 100); assert.equal(inserts, 100);
assert.equal(slots.size, 0);
assert.ok([...tasks.values()].every(task => task.status === 'completed' && task.retry_count === 0));
console.log(`Outbound queue capacity verification passed (${live ? 'real Redis Lua / simulated database and dialer' : 'simulation'}): initially 3 dialed / 97 queued; all 100 drained once with peak concurrency 3, schedules, credits and retries preserved.`);
} finally {
  if (testRedis) {
    const { env } = await import('../src/config/env.js');
    const keys = await testRedis.keys(`${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:*`);
    if (keys.length) await testRedis.del(...keys);
    await testRedis.quit();
  }
}
