import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.VOICE_COMPANY_QUEUE_ENABLED = 'false';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= '127.0.0.1';
const { VoiceCallOwnership } = await import('../src/voice/call-ownership.service.js');
const { admitAnsweredCall } = await import('../src/voice/call-capacity.service.js');
const { startAgentPhoneTest } = await import('../src/agents/agent-phone-test.service.js');
const { executeCampaignTask, finishAttempt } = await import('../src/campaigns/campaign-execution.service.js');

// Deterministic lease simulator; --redis executes the same cases using actual
// Lua on a local Redis server (never the application's configured Redis).
class LeaseRedis {
  status = 'ready'; time = 0; values = new Map(); sets = new Map();
  value(key) {
    const item = this.values.get(key);
    if (item && item.expires > this.time) return item.value;
    this.values.delete(key); return null;
  }
  put(key, value, ttl) { this.values.set(key, { value, expires: this.time + ttl * 1000 }); }
  async get(key) { return this.value(key); }
  async eval(script, count, ...args) {
    const keys = args.splice(0, count);
    const [tenant, instance] = args;
    const set = this.sets.get(keys[0]) ?? new Map(); this.sets.set(keys[0], set);
    const owner = this.value(keys[1]);
    if (script.includes('-- voice-call-acquire')) {
      const [, , now, ttl, limit, call] = args;
      if (owner) return owner.startsWith(`${tenant}|`) ? 2 : -1;
      for (const [id, expiry] of set) if (expiry <= now) set.delete(id);
      if (set.size >= limit) return 0;
      this.put(keys[1], `${tenant}|reserved|${instance}`, ttl); set.set(call, now + ttl * 1000); return 1;
    }
    if (script.includes('-- voice-call-bind')) {
      const [, reservation, call, ttl, now, receiver] = args;
      const bound = this.value(keys[3]);
      if (bound) return bound === call ? 2 : -1;
      if (!owner) return 0;
      if (!owner.startsWith(`${tenant}|`) || this.value(keys[2])) return -1;
      this.put(keys[2], `${tenant}|reserved|${receiver}`, ttl); this.put(keys[3], call, ttl);
      this.values.delete(keys[1]); set.delete(reservation); set.set(call, now + ttl * 1000); return 1;
    }
    if (script.includes('-- voice-call-release-reservation')) {
      const [, reservation, prefix] = args;
      const bound = this.value(keys[2]);
      this.values.delete(keys[1]); set.delete(reservation);
      if (bound) { this.values.delete(prefix + bound); set.delete(bound); } return 1;
    }
    if (script.includes('-- voice-call-claim')) {
      const [, , ttl, now, call] = args;
      if (!owner?.startsWith(`${tenant}|`)) return -1;
      if (!owner.includes('|reserved|') && owner !== `${tenant}|active|${instance}`) return 0;
      this.put(keys[1], `${tenant}|active|${instance}`, ttl); set.set(call, now + ttl * 1000); return 1;
    }
    if (script.includes('-- voice-call-heartbeat')) {
      const [, , ttl, now, call] = args;
      if (owner !== `${tenant}|active|${instance}`) return 0;
      this.put(keys[1], owner, ttl); set.set(call, now + ttl * 1000); return 1;
    }
    if (script.includes('-- voice-call-release-validated')) {
      if (owner && !owner.startsWith(`${tenant}|`)) return 0;
      this.values.delete(keys[1]); set.delete(args[1]); return 1;
    }
    if (script.includes('-- voice-call-release')) {
      if (owner && ![`${tenant}|reserved|${instance}`, `${tenant}|active|${instance}`].includes(owner)) return 0;
      this.values.delete(keys[1]); set.delete(args[2]); return 1;
    }
    throw new Error('Unsupported script');
  }
}

const live = process.argv.includes('--redis');
let redis;
if (live) {
  const { Redis } = await import('ioredis');
  redis = new Redis({ host: '127.0.0.1', port: Number(process.env.CAPACITY_TEST_REDIS_PORT ?? 6379),
    lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  await redis.connect();
} else redis = new LeaseRedis();
const now = () => live ? Date.now() : redis.time;
const ownership = new VoiceCallOwnership({ redis, instanceId: 'test-a', ttlSeconds: live ? 1 : 60, now });
const other = new VoiceCallOwnership({ redis, instanceId: 'test-b', ttlSeconds: live ? 1 : 60, now });
const tenantId = `capacity-test-${randomUUID()}`;
const full = (error) => error.code === 'VOICE_COMPANY_CONCURRENCY_LIMIT';
const reserve = (id, limit = 3) => ownership.acquire({ tenantId, providerCallId: id, limit });
const release = (id) => ownership.releaseValidated({ tenantId, providerCallId: id });
try {
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => reserve(`mixed-${i}`)));
  const admitted = results.flatMap((r, i) => r.status === 'fulfilled' ? [`mixed-${i}`] : []);
  assert.equal(admitted.length, 3); assert.ok(results.filter(r => r.status === 'rejected').every(r => full(r.reason)));
  assert.equal((await reserve(admitted[0])).idempotent, true);
  await assert.rejects(reserve('overflow'), full);
  await ownership.acquire({ tenantId: `${tenantId}-other`, providerCallId: 'isolated', limit: 1 });
  await ownership.releaseValidated({ tenantId: `${tenantId}-other`, providerCallId: 'isolated' });
  for (const id of admitted) await release(id);

  await reserve('pre-dial', 1);
  await admitAnsweredCall({ tenantId, providerCallId: 'answered', limit: 1, reservationId: 'pre-dial' }, ownership);
  assert.equal((await admitAnsweredCall({ tenantId, providerCallId: 'answered', limit: 1, reservationId: 'pre-dial' }, other)).acquired, false);
  await assert.rejects(ownership.bindReservation({ tenantId, reservationId: 'pre-dial', providerCallId: 'different' }),
    e => e.code === 'VOICE_CALL_OWNERSHIP_CONFLICT');
  await assert.rejects(reserve('second', 1), full);
  await other.claimMedia({ tenantId, providerCallId: 'answered' });
  assert.equal(await ownership.release({ tenantId, providerCallId: 'answered' }), false);
  assert.equal(await other.heartbeat({ tenantId, providerCallId: 'answered' }), true);
  await ownership.releaseReservation({ tenantId, reservationId: 'pre-dial' });
  await ownership.releaseReservation({ tenantId, reservationId: 'pre-dial' });
  await reserve('replacement', 1); await release('replacement');

  // A short media lease must not shorten the shared index below another
  // worker's 300-second pre-dial reservation (verified against Redis itself).
  if (live) {
    await ownership.acquire({ tenantId, providerCallId: 'long-reservation', limit: 3, ttlSeconds: 300 });
    await other.acquire({ tenantId, providerCallId: 'short-media', limit: 3 });
    await other.claimMedia({ tenantId, providerCallId: 'short-media' });
    await other.heartbeat({ tenantId, providerCallId: 'short-media' });
    const { env } = await import('../src/config/env.js');
    assert.ok(await redis.pttl(`${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:calls`) > 290000,
      'Short media heartbeat prematurely expires long company reservations');
    await release('long-reservation'); await release('short-media');
  }

  await reserve('expired', 1);
  if (live) await new Promise(resolve => setTimeout(resolve, 1100)); else redis.time += 60001;
  await assert.rejects(ownership.claimMedia({ tenantId, providerCallId: 'expired' }),
    e => e.code === 'VOICE_MEDIA_OWNERSHIP_UNAVAILABLE');
  await reserve('recovered', 1); await release('recovered');
  await assert.rejects(ownership.acquire({ tenantId, providerCallId: 'bad', limit: 0 }),
    e => e.code === 'COMPANY_CONCURRENCY_NOT_CONFIGURED');
  await assert.rejects(ownership.acquire({ tenantId, providerCallId: 'bad' }),
    e => e.code === 'COMPANY_CONCURRENCY_NOT_CONFIGURED');

  // Campaign admission sees slots held by inbound or phone-test calls.
  await reserve('inbound', 1);
  let makeCalls = 0;
  const task = { id: 'task', tenant_id: tenantId, campaign_id: 'campaign', campaign_status: 'running',
    status: 'queued', available_credits: 100, low_credit_threshold: 1,
    max_total_concurrency: 1, concurrency_limit: 3, calling_start_time: '00:00', calling_end_time: '23:59' };
  const deferred = await executeCampaignTask('task', {
    ownership, contextRunner: async operation => operation({ query: async sql => {
      if (sql.includes('SELECT t.*')) return { rowCount: 1, rows: [task] };
      if (sql.includes('AS allowed')) return { rows: [{ allowed: true }] };
      if (sql.includes('AS campaign_active')) return { rows: [{ campaign_active: 0 }] };
      return { rows: [] };
    } }),
    deferTask: async () => {}, makeCall: async () => { makeCalls++; },
  });
  assert.equal(deferred.reason, 'concurrency'); assert.equal(makeCalls, 0);
  await release('inbound');

  await assert.rejects(executeCampaignTask('task', {
    ownership, contextRunner: async operation => operation({ query: async sql => {
      if (sql.includes('SELECT t.*')) return { rowCount: 1, rows: [task] };
      if (sql.includes('AS allowed')) return { rows: [{ allowed: true }] };
      if (sql.includes('AS campaign_active')) return { rows: [{ campaign_active: 0 }] };
      return { rows: [] };
    } }), reserveCredit: async () => { throw new Error('transaction failed'); },
  }), /transaction failed/);
  await reserve('after-rollback', 1); await release('after-rollback');
  await assert.rejects(new VoiceCallOwnership({ redis: { status: 'reconnecting' } }).acquire({ tenantId,
    providerCallId: 'unavailable', limit: 1 }), e => e.code === 'VOICE_COORDINATION_UNAVAILABLE');
  await assert.rejects(new VoiceCallOwnership({ redis: { status: 'ready',
    eval: async () => { throw new Error('command timeout'); } } }).acquire({ tenantId,
    providerCallId: 'timeout', limit: 1 }), e => e.code === 'VOICE_COORDINATION_UNAVAILABLE');

  // Failed provider dispatch immediately returns a phone-test slot.
  await assert.rejects(startAgentPhoneTest({ userId: 'user', tenantId, workspaceId: 'workspace' }, 'agent',
    { phone: '+919876543210' }, {
      ownership, contextRunner: async (_user, operation) => operation({ query: async () => ({ rowCount: 1, rows: [{
        status: 'active', usage_direction: 'both', e164: '+918065587447', account_status: 'connected',
        answer_url: 'https://example.com/answer', hangup_url: 'https://example.com/hangup', max_total_concurrency: 1,
      }] }) }), validateModels: async () => {}, checkCredits: async () => {}, decrypt: () => 'secret',
      makeCall: async () => { throw new Error('provider rejected'); },
    }), /provider rejected/);
  await reserve('after-failure', 1); await release('after-failure');

  // Terminal duplicates also clean reservations and do not repeat billing.
  await reserve('campaign-reservation', 1);
  const finished = await finishAttempt('attempt', 'completed', {}, {
    ownership, contextRunner: async operation => operation({ query: async () => ({ rowCount: 1, rows: [{
      ended_at: new Date(), capacity_tenant_id: tenantId,
      capacity_metadata: { capacityReservationId: 'campaign-reservation' },
    }] }) }),
  });
  assert.equal(finished.reason, 'already_final');
  await reserve('after-final', 1); await release('after-final');
  console.log(`Company call capacity verification passed (${live ? 'real Redis Lua' : 'deterministic lease simulation'}).`);
} finally {
  if (live) {
    // Only this test tenant's random namespace is touched.
    const { env } = await import('../src/config/env.js');
    const testKeys = await redis.keys(`${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:*`);
    if (testKeys.length) await redis.del(...testKeys);
    await redis.quit();
  }
}
