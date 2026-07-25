import assert from 'node:assert/strict';
import { ConversationContextCache } from '../src/voice/interaction/conversation-context-cache.service.js';

class FakeRedis {
  status = 'ready';
  values = new Map();
  calls = [];
  async get(key) { this.calls.push(['get', key]); return this.values.get(key) ?? null; }
  async set(key, value, mode, ttl) {
    this.calls.push(['set', key, mode, ttl]);
    this.values.set(key, value);
    return 'OK';
  }
  async del(key) { this.calls.push(['del', key]); return this.values.delete(key) ? 1 : 0; }
}

const descriptor = {
  key: 'zea:test:conversation', readEnabled: true, writeEnabled: true, ttlSeconds: 86400,
};
const redis = new FakeRedis();
const cache = new ConversationContextCache({ redis, timeoutMs: 100, maxBytes: 4096 });
const state = { summary: 'Previous call', recentMessages: [{ role: 'user', content: 'Call later' }] };

assert.equal(await cache.set(descriptor, state), true);
assert.deepEqual(redis.calls[0], ['set', descriptor.key, 'EX', 86400]);
const loaded = await cache.get(descriptor);
assert.equal(loaded.summary, 'Previous call');
assert.equal(loaded.recentMessages[0].content, 'Call later');

redis.values.set(descriptor.key, '{invalid json');
assert.equal(await cache.get(descriptor), null);
assert.equal(redis.values.has(descriptor.key), false);

const callsBeforeDisabled = redis.calls.length;
assert.equal(await cache.get({ ...descriptor, readEnabled: false }), null);
assert.equal(await cache.set({ ...descriptor, writeEnabled: false }, state), false);
assert.equal(redis.calls.length, callsBeforeDisabled);

const smallCache = new ConversationContextCache({ redis, timeoutMs: 100, maxBytes: 64 });
assert.equal(await smallCache.set(descriptor, { summary: 'x'.repeat(500) }), false);

console.log(JSON.stringify({ success: true, task: 'Redis 24-hour conversation cache' }));
