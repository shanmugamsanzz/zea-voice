import { env } from '../../config/env.js';
import { redis } from '../../infrastructure/redis.js';
import { normalizeConversationMemoryState } from './conversation-memory-state.js';

const timeout = Symbol('timeout');

async function bounded(operation, timeoutMs) {
  let timer;
  return Promise.race([
    operation,
    new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

export class ConversationContextCache {
  constructor(options = {}) {
    this.redis = options.redis ?? redis;
    this.timeoutMs = options.timeoutMs ?? env.VOICE_CONTEXT_CACHE_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? env.VOICE_CONTEXT_CACHE_MAX_BYTES;
  }

  async get(descriptor) {
    if (!descriptor?.readEnabled || !descriptor.key) return null;
    try {
      if (this.redis.status && this.redis.status !== 'ready') return null;
      const encoded = await bounded(this.redis.get(descriptor.key), this.timeoutMs);
      if (!encoded || encoded === timeout || Buffer.byteLength(encoded) > this.maxBytes) return null;
      return normalizeConversationMemoryState(JSON.parse(encoded));
    } catch {
      try { await bounded(this.redis.del(descriptor.key), this.timeoutMs); } catch {}
      return null;
    }
  }

  async set(descriptor, state) {
    if (!descriptor?.writeEnabled || !descriptor.key || descriptor.ttlSeconds <= 0) return false;
    try {
      if (this.redis.status && this.redis.status !== 'ready') return false;
      const encoded = JSON.stringify(normalizeConversationMemoryState(state));
      if (Buffer.byteLength(encoded) > this.maxBytes) return false;
      const result = await bounded(
        this.redis.set(descriptor.key, encoded, 'EX', descriptor.ttlSeconds),
        this.timeoutMs,
      );
      return result === 'OK';
    } catch { return false; }
  }

  async delete(keyOrDescriptor) {
    const key = typeof keyOrDescriptor === 'string' ? keyOrDescriptor : keyOrDescriptor?.key;
    if (!key) return false;
    try {
      if (this.redis.status && this.redis.status !== 'ready') return false;
      const result = await bounded(this.redis.del(key), this.timeoutMs);
      return result !== timeout && Number(result) >= 0;
    } catch { return false; }
  }
}

export const conversationContextCache = new ConversationContextCache();

