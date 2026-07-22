import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import { AppError } from '../middleware/errors.js';

const instanceId = env.VOICE_RUNTIME_INSTANCE_ID ?? `${hostname()}:${process.pid}:${randomUUID()}`;

const acquireScript = `-- voice-call-acquire
local owner = redis.call('GET', KEYS[2])
if owner then
  if string.sub(owner, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then return 2 end
  return -1
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
redis.call('SET', KEYS[2], ARGV[1] .. '|reserved|' .. ARGV[2], 'EX', ARGV[4], 'NX')
if not redis.call('GET', KEYS[2]) then return -1 end
redis.call('ZADD', KEYS[1], ARGV[3] + (ARGV[4] * 1000), ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[4] * 2)
return 1`;

const claimScript = `-- voice-call-claim
local owner = redis.call('GET', KEYS[2])
if not owner then return 0 end
local prefix = ARGV[1] .. '|'
if string.sub(owner, 1, string.len(prefix)) ~= prefix then return -1 end
local active = ARGV[1] .. '|active|' .. ARGV[2]
if string.find(owner, '|reserved|', 1, true) or owner == active then
  redis.call('SET', KEYS[2], active, 'EX', ARGV[3])
  redis.call('ZADD', KEYS[1], ARGV[4] + (ARGV[3] * 1000), ARGV[5])
  redis.call('EXPIRE', KEYS[1], ARGV[3] * 2)
  return 1
end
return 0`;

const heartbeatScript = `-- voice-call-heartbeat
local expected = ARGV[1] .. '|active|' .. ARGV[2]
if redis.call('GET', KEYS[2]) ~= expected then return 0 end
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4] + (ARGV[3] * 1000), ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[3] * 2)
return 1`;

const releaseScript = `-- voice-call-release
local owner = redis.call('GET', KEYS[2])
if not owner then redis.call('ZREM', KEYS[1], ARGV[3]); return 1 end
local reserved = ARGV[1] .. '|reserved|' .. ARGV[2]
local active = ARGV[1] .. '|active|' .. ARGV[2]
if owner ~= reserved and owner ~= active then return 0 end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[3])
return 1`;

const releaseValidatedScript = `-- voice-call-release-validated
local owner = redis.call('GET', KEYS[2])
if owner and string.sub(owner, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. '|' then return 0 end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[2])
return 1`;

function keys(tenantId, providerCallId) {
  const safeTenant = String(tenantId);
  const safeCall = String(providerCallId);
  return [
    `${env.QUEUE_PREFIX}:voice:tenant:{${safeTenant}}:calls`,
    `${env.QUEUE_PREFIX}:voice:tenant:{${safeTenant}}:call:${safeCall}`,
  ];
}

export class VoiceCallOwnership {
  constructor(options = {}) {
    this.redis = options.redis ?? redis;
    this.instanceId = options.instanceId ?? instanceId;
    this.ttlSeconds = options.ttlSeconds ?? env.VOICE_CALL_OWNERSHIP_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  #assertReady() {
    if (this.redis.status && this.redis.status !== 'ready') {
      throw new AppError(503, 'Distributed voice-call coordination is unavailable', 'VOICE_COORDINATION_UNAVAILABLE');
    }
  }

  async acquire({ tenantId, providerCallId, limit }) {
    this.#assertReady();
    const [tenantKey, callKey] = keys(tenantId, providerCallId);
    const effectiveLimit = Number(limit ?? env.VOICE_COMPANY_DEFAULT_CONCURRENCY);
    const result = Number(await this.redis.eval(acquireScript, 2, tenantKey, callKey,
      tenantId, this.instanceId, this.now(), this.ttlSeconds, effectiveLimit, providerCallId));
    if (result === 0) {
      throw new AppError(429, 'Company concurrent voice-call limit has been reached', 'VOICE_COMPANY_CONCURRENCY_LIMIT', {
        limit: effectiveLimit,
      });
    }
    if (result < 0) throw new AppError(409, 'Voice call is owned by another company', 'VOICE_CALL_OWNERSHIP_CONFLICT');
    return { acquired: result === 1, idempotent: result === 2, tenantId, providerCallId, limit: effectiveLimit };
  }

  async claimMedia({ tenantId, providerCallId }) {
    this.#assertReady();
    const [tenantKey, callKey] = keys(tenantId, providerCallId);
    const result = Number(await this.redis.eval(claimScript, 2, tenantKey, callKey,
      tenantId, this.instanceId, this.ttlSeconds, this.now(), providerCallId));
    if (result !== 1) throw new AppError(409, 'Voice call media is already owned or its reservation expired', 'VOICE_MEDIA_OWNERSHIP_UNAVAILABLE');
    return true;
  }

  async heartbeat({ tenantId, providerCallId }) {
    this.#assertReady();
    const [tenantKey, callKey] = keys(tenantId, providerCallId);
    return Number(await this.redis.eval(heartbeatScript, 2, tenantKey, callKey,
      tenantId, this.instanceId, this.ttlSeconds, this.now(), providerCallId)) === 1;
  }

  async release({ tenantId, providerCallId }) {
    this.#assertReady();
    const [tenantKey, callKey] = keys(tenantId, providerCallId);
    return Number(await this.redis.eval(releaseScript, 2, tenantKey, callKey,
      tenantId, this.instanceId, providerCallId)) === 1;
  }

  async releaseValidated({ tenantId, providerCallId }) {
    this.#assertReady();
    const [tenantKey, callKey] = keys(tenantId, providerCallId);
    return Number(await this.redis.eval(releaseValidatedScript, 2, tenantKey, callKey,
      tenantId, providerCallId)) === 1;
  }
}

export const voiceCallOwnership = new VoiceCallOwnership();
