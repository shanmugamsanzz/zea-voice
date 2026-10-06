import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= '127.0.0.1';
const { InboundCallQueue, buildInboundQueueXml, createHoldMusic } = await import('../src/voice/inbound-call-queue.service.js');
const { VoiceCallOwnership } = await import('../src/voice/call-ownership.service.js');

class QueueRedis {
  status = 'ready'; time = 1000; values = new Map(); sets = new Map(); hashes = new Map(); seq = 0;
  set(key) { if (!this.sets.has(key)) this.sets.set(key, new Map()); return this.sets.get(key); }
  hash(key) { if (!this.hashes.has(key)) this.hashes.set(key, new Map()); return this.hashes.get(key); }
  getValue(key) {
    const entry = this.values.get(key);
    if (entry?.expires > this.time) return entry.value;
    this.values.delete(key); return null;
  }
  put(key, value, ttl) { this.values.set(key, { value, expires: this.time + ttl * 1000 }); }
  async get(key) { return this.getValue(key); }
  cleanup(order, lease, state, now, prefix, retention) {
    for (const [id, expires] of lease) if (expires <= now) {
      order.delete(id); lease.delete(id); state.delete(id); this.put(prefix + id + ':ended', 'expired', retention);
    }
  }
  async eval(script, count, ...args) {
    const keys = args.splice(0, count);
    const active = this.set(keys[0]);
    if (script.includes('-- inbound-call-cancel')) {
      const [call, retention] = args;
      const waiting = this.hash(keys[4]).has(call);
      this.set(keys[2]).delete(call); this.set(keys[3]).delete(call); this.hash(keys[4]).delete(call); this.hash(keys[7]).delete(call);
      this.put(keys[6], 'ended', retention); this.values.delete(keys[1]); active.delete(call);
      return waiting ? 1 : 0;
    }
    if (script.includes('-- inbound-call-admit')) {
      const [tenant, call, now, ttl, limit, maxSize, maxWait, liveSeconds, prefix, instance, metadataJson] = args;
      const metadata = this.hash(keys[7]);
      const order = this.set(keys[2]), lease = this.set(keys[3]), state = this.hash(keys[4]);
      this.cleanup(order, lease, state, now, prefix, maxWait + ttl);
      if (this.getValue(keys[6])) return [-2, 0];
      if (this.getValue(keys[1])) return [2, 0];
      for (const [id, expires] of active) if (expires <= now) active.delete(id);
      const admit = () => {
        order.delete(call); lease.delete(call); state.delete(call); metadata.delete(call);
        this.put(keys[1], `${tenant}|reserved|${instance}`, ttl); active.set(call, now + ttl * 1000);
        return [1, 0];
      };
      let deadline = state.get(call);
      if (deadline && metadata.has(call)) {
        deadline = JSON.parse(metadata.get(call)).arrivedAt + maxWait * 1000;
        if (deadline <= now) {
          order.delete(call); lease.delete(call); state.delete(call); metadata.delete(call);
          this.put(keys[6], 'expired', maxWait + ttl); return [-2, 0];
        }
        state.set(call, deadline);
      }
      if (!deadline) {
        if (active.size < limit && !order.size) return admit();
        if (order.size >= maxSize) { this.put(keys[6], 'full', maxWait + ttl); return [-1, 0]; }
        deadline = now + maxWait * 1000; order.set(call, ++this.seq); state.set(call, deadline);
        metadata.set(call, metadataJson);
      }
      const head = [...order].sort((a, b) => a[1] - b[1])[0]?.[0];
      if (head === call && active.size < limit) return admit();
      lease.set(call, Math.min(deadline, now + liveSeconds * 1000)); return [0, deadline - now];
    }
    if (script.includes('-- voice-call-acquire')) {
      const [tenant, instance, now, ttl, limit, call, orderKey, leaseKey, stateKey, prefix] = args;
      if (this.getValue(keys[1])) return 2;
      for (const [id, expires] of active) if (expires <= now) active.delete(id);
      const order = this.set(orderKey);
      this.cleanup(order, this.set(leaseKey), this.hash(stateKey), now, prefix, 3900);
      if (order.size || active.size >= limit) return 0;
      this.put(keys[1], `${tenant}|reserved|${instance}`, ttl); active.set(call, now + ttl * 1000); return 1;
    }
    if (script.includes('-- voice-call-release-validated')) {
      this.values.delete(keys[1]); active.delete(args[1]); return 1;
    }
    throw new Error('Unknown script');
  }
}

const live = process.argv.includes('--redis');
let redis;
if (live) {
  const { Redis } = await import('ioredis');
  redis = new Redis({ host: '127.0.0.1', port: Number(process.env.CAPACITY_TEST_REDIS_PORT ?? 6379),
    lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  await redis.connect();
} else redis = new QueueRedis();
const now = () => live ? Date.now() : redis.time;
const tenantId = `inbound-test-${randomUUID()}`;
const ownership = new VoiceCallOwnership({ redis, instanceId: 'queue-test', now });
const queue = new InboundCallQueue({ redis, ownership, now, maxSize: 2, maxWaitSeconds: live ? 1 : 10, pollSeconds: 1 });
const admit = id => queue.admit({ tenantId, providerCallId: id, limit: 1 });
const release = id => ownership.releaseValidated({ tenantId, providerCallId: id });
try {
  assert.equal((await admit('active')).status, 'admitted');
  assert.equal((await admit('first')).status, 'waiting');
  assert.equal((await admit('second')).status, 'waiting');
  assert.equal((await admit('overflow')).status, 'full');
  const repeated = await admit('first');
  assert.equal(repeated.status, 'waiting');
  await release('active');
  assert.equal((await admit('second')).status, 'waiting');
  await assert.rejects(ownership.acquire({ tenantId, providerCallId: 'outbound', limit: 1 }),
    e => e.code === 'VOICE_COMPANY_CONCURRENCY_LIMIT');
  assert.equal((await admit('first')).status, 'admitted');
  assert.equal((await admit('first')).acquired, false);
  await release('first');
  assert.equal((await admit('second')).status, 'admitted');
  assert.equal((await admit('hung-up')).status, 'waiting');
  assert.equal(await queue.cancel({ tenantId, providerCallId: 'hung-up' }), true);
  assert.equal(await queue.cancel({ tenantId, providerCallId: 'hung-up' }), false);
  assert.equal((await admit('hung-up')).status, 'ended');
  assert.equal((await admit('timeout')).status, 'waiting');
  if (live) await new Promise(resolve => setTimeout(resolve, 1100)); else redis.time += 10001;
  assert.equal((await admit('timeout')).status, 'ended');
  await release('second');
  assert.equal((await admit('replacement')).status, 'admitted');
  const otherTenant = `${tenantId}-other`;
  assert.equal((await queue.admit({ tenantId: otherTenant, providerCallId: 'isolated', limit: 1 })).status, 'admitted');
  await ownership.releaseValidated({ tenantId: otherTenant, providerCallId: 'isolated' });
  await release('replacement');
  await queue.cancel({ tenantId, providerCallId: 'hangup-before-answer' });
  assert.equal((await admit('hangup-before-answer')).status, 'ended');

  if (!live) {
    const recovery = new InboundCallQueue({ redis, ownership, now, maxSize: 2, maxWaitSeconds: 120, pollSeconds: 1 });
    const recoverAdmit = id => recovery.admit({ tenantId, providerCallId: id, limit: 1 });
    await recoverAdmit('occupied'); await recoverAdmit('abandoned');
    redis.time += 20000; await recoverAdmit('next');
    await release('occupied'); redis.time += 10001;
    assert.equal((await recoverAdmit('next')).status, 'admitted');
    assert.equal((await recoverAdmit('abandoned')).status, 'ended');
    await release('next');
    await recoverAdmit('lost-runtime'); redis.time += 300001;
    assert.equal((await recoverAdmit('lease-replacement')).status, 'admitted');
    await release('lease-replacement');
    await recoverAdmit('settings-active');
    assert.equal((await recovery.admit({ tenantId, providerCallId: 'company-settings', limit: 1,
      maxSize: 1, maxWaitSeconds: 60 })).status, 'waiting');
    assert.equal((await recovery.admit({ tenantId, providerCallId: 'company-overflow', limit: 1,
      maxSize: 1, maxWaitSeconds: 60 })).status, 'full');
    redis.time += 15000;
    assert.equal((await recovery.admit({ tenantId, providerCallId: 'company-settings', limit: 1,
      maxSize: 1, maxWaitSeconds: 10 })).status, 'ended');
    await release('settings-active');
  }

  // Mixed sources share all three slots; waiting inbound callers have FIFO
  // priority over batch/realtime/phone-test reservation attempts.
  const mixed = new InboundCallQueue({ redis, ownership, now, maxSize: 100, maxWaitSeconds: 60 });
  const mixedAdmit = id => mixed.admit({ tenantId, providerCallId: id, limit: 3 });
  await ownership.acquire({ tenantId, providerCallId: 'mixed-batch', limit: 3 });
  await ownership.acquire({ tenantId, providerCallId: 'mixed-realtime', limit: 3 });
  assert.equal((await mixedAdmit('mixed-inbound')).status, 'admitted');
  const waitingResults = await Promise.all(['mixed-first', 'mixed-second', 'mixed-third'].map(mixedAdmit));
  assert.ok(waitingResults.every(result => result.status === 'waiting'));
  assert.equal((await mixedAdmit('mixed-first')).acquired, false);
  await release('mixed-batch');
  await assert.rejects(ownership.acquire({ tenantId, providerCallId: 'mixed-phone-test', limit: 3 }),
    e => e.code === 'VOICE_COMPANY_CONCURRENCY_LIMIT');
  // Recreate the process services with a different instance: no in-memory
  // queue is carried forward, and the Redis-backed order remains intact.
  const restartedOwnership = new VoiceCallOwnership({ redis, instanceId: 'restarted-process', now });
  const restartedQueue = new InboundCallQueue({ redis, ownership: restartedOwnership, now,
    maxSize: 100, maxWaitSeconds: 60 });
  const restartedAdmit = id => restartedQueue.admit({ tenantId, providerCallId: id, limit: 3 });
  assert.equal((await restartedAdmit('mixed-third')).status, 'waiting');
  assert.equal((await restartedAdmit('mixed-first')).status, 'admitted');
  assert.equal((await restartedAdmit('mixed-first')).acquired, false);
  assert.equal((await restartedQueue.admit({ tenantId: otherTenant, providerCallId: 'mixed-first', limit: 1 })).status, 'admitted');
  await ownership.releaseValidated({ tenantId: otherTenant, providerCallId: 'mixed-first' });
  await release('mixed-first'); await release('mixed-first');
  assert.equal((await restartedAdmit('mixed-third')).status, 'waiting');
  assert.equal((await restartedAdmit('mixed-second')).status, 'admitted');
  assert.equal(await restartedQueue.cancel({ tenantId, providerCallId: 'mixed-third' }), true);
  assert.equal(await restartedQueue.cancel({ tenantId, providerCallId: 'mixed-third' }), false);
  assert.equal((await restartedAdmit('mixed-third')).status, 'ended');
  await release('mixed-realtime'); await release('mixed-inbound'); await release('mixed-second');
  await restartedOwnership.acquire({ tenantId, providerCallId: 'mixed-after-drain', limit: 3 });
  await release('mixed-after-drain');

  const xml = buildInboundQueueXml({ status: 'waiting', remainingMs: 2000 },
    'https://example.com/api/webhooks/plivo/answer?a=1&b=2', { publicBaseUrl: 'https://example.com/api', pollSeconds: 4 });
  assert.match(xml, /<Play>https:\/\/example.com\/api\/webhooks\/plivo\/hold-music.wav\?seconds=2<\/Play>/);
  assert.match(xml, /<Redirect method="POST">/); assert.match(xml, /a=1&amp;b=2&amp;queue_poll=1/);
  assert.doesNotMatch(xml, /<Stream|loop="0"/);
  assert.match(buildInboundQueueXml({ status: 'full' }), /<Hangup\/>/);
  assert.match(buildInboundQueueXml({ status: 'ended' }), /waiting time/);
  const music = createHoldMusic(2);
  assert.equal(music.length, 32044); assert.equal(music.toString('ascii', 0, 4), 'RIFF');
  assert.equal(music.readUInt32LE(24), 8000); assert.equal(music.readUInt16LE(22), 1);
  assert.ok(music.subarray(44).some(byte => byte !== 0));
  console.log(`Inbound waiting verified (${live ? 'real Redis Lua' : 'simulation'}): FIFO, hold music, bounds, hangups, expiry, isolation and outbound fairness.`);
} finally {
  if (live) {
    const { env } = await import('../src/config/env.js');
    const keys = await redis.keys(`${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
}
