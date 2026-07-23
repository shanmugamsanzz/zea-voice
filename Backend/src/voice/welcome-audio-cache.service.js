import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';

function cacheKey(runtimeProfile, text) {
  const tts = runtimeProfile.providers.tts;
  const identity = JSON.stringify({
    tenantId: runtimeProfile.agent.tenantId,
    providerId: tts.providerId,
    modelId: tts.modelId,
    voiceId: runtimeProfile.agent.voiceId ?? tts.effectiveSettings?.voiceId,
    language: runtimeProfile.agent.language,
    settings: tts.effectiveSettings,
    text,
  });
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return `${env.QUEUE_PREFIX}:voice:welcome:${runtimeProfile.agent.tenantId}:${digest}`;
}

async function bounded(operation, timeoutMs) {
  let timer;
  return Promise.race([
    operation,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

export class WelcomeAudioCache {
  constructor(options = {}) {
    this.redis = options.redis ?? redis;
    this.timeoutMs = options.timeoutMs ?? env.VOICE_WELCOME_CACHE_TIMEOUT_MS;
    this.ttlSeconds = options.ttlSeconds ?? env.VOICE_WELCOME_CACHE_TTL_SECONDS;
    this.maxBytes = options.maxBytes ?? env.VOICE_WELCOME_CACHE_MAX_BYTES;
  }

  async get(runtimeProfile, text) {
    try {
      if (this.redis.status && this.redis.status !== 'ready') return null;
      const encoded = await bounded(this.redis.get(cacheKey(runtimeProfile, text)), this.timeoutMs);
      if (!encoded) return null;
      const audio = Buffer.from(encoded, 'base64');
      return audio.length && audio.length <= this.maxBytes ? audio : null;
    } catch { return null; }
  }

  async set(runtimeProfile, text, audio) {
    if (!Buffer.isBuffer(audio) || !audio.length || audio.length > this.maxBytes) return false;
    try {
      if (this.redis.status && this.redis.status !== 'ready') return false;
      const result = await bounded(
        this.redis.set(cacheKey(runtimeProfile, text), audio.toString('base64'), 'EX', this.ttlSeconds),
        this.timeoutMs,
      );
      return result === 'OK';
    } catch { return false; }
  }
}

export const welcomeAudioCache = new WelcomeAudioCache();
