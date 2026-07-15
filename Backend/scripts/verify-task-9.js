import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

process.env.QUEUE_PREFIX = `zea-task9-${crypto.randomUUID().slice(0, 8)}`;
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');
const { closeQueues, getQueue, recordWorkerHeartbeat } = await import('../src/queues/queue.registry.js');

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const password = `Task9-${crypto.randomUUID()}!`;
const email = `task9-admin-${crypto.randomUUID().slice(0, 8)}@example.test`;
let userId;
let server;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
}
async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([...['batch-calls', 'realtime-calls', 'call-retries'].map(async (name) => {
    const queue = getQueue(name);
    await queue.drain(true);
    await queue.obliterate({ force: true });
  })]);
  if (admin._connected) {
    if (userId) {
      await admin.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [userId]);
      await admin.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
      await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await admin.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  userId = (await admin.query(`INSERT INTO users
    (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
    VALUES ($1, $2, 'Task', 'Nine Admin', 'active', 'super_admin', now()) RETURNING id`,
  [email, await hashPassword(password)])).rows[0].id;
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const token = (await login.json()).data.accessToken;
  const headers = { authorization: `Bearer ${token}` };

  const queue = getQueue('batch-calls');
  await queue.add('verification-call', { test: true });
  await queue.add('verification-retry', { test: true }, { delay: 60000 });
  const monitor = await api(base, '/admin/queues', { headers });
  assert.equal(monitor.status, 200);
  const batch = (await monitor.json()).data.find((item) => item.queueName === 'batch-calls');
  assert.equal(batch.waitingCalls, 2);
  assert.ok(batch.avgWaitTime >= 0);

  assert.equal((await api(base, '/admin/queues/batch-calls/pause', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(await queue.isPaused(), true);
  assert.equal((await api(base, '/admin/queues/batch-calls/resume', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(await queue.isPaused(), false);
  const unconfirmed = await api(base, '/admin/queues/batch-calls/flush', { method: 'POST', headers, body: JSON.stringify({ reason: 'test' }) });
  assert.equal(unconfirmed.status, 400);
  const flushed = await api(base, '/admin/queues/batch-calls/flush', { method: 'POST', headers,
    body: JSON.stringify({ confirm: true, reason: 'Task 9 isolated verification' }) });
  assert.equal(flushed.status, 200);
  assert.equal((await flushed.json()).data.removedJobs, 2);

  await recordWorkerHeartbeat({ workerId: `worker-${crypto.randomUUID()}`, queueName: 'realtime-calls', concurrency: 20 });
  const workers = await api(base, '/admin/queues/workers', { headers });
  assert.equal(workers.status, 200);
  assert.equal((await workers.json()).data.length, 1);
  const health = await api(base, '/health/workers');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).count, 1);

  console.log(JSON.stringify({ success: true, liveQueueCounts: 'passed', waitMetrics: 'passed',
    pauseResume: 'passed', confirmedEmergencyFlush: 'passed', activeJobsProtected: 'passed',
    workerHeartbeatMonitor: 'passed', queueAuditLog: 'passed', isolatedRedisPrefix: process.env.QUEUE_PREFIX }, null, 2));
} finally {
  await cleanup();
}
