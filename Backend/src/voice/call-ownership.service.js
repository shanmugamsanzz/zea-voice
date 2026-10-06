import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import { AppError } from '../middleware/errors.js';

const instanceId = env.VOICE_RUNTIME_INSTANCE_ID ?? `${hostname()}:${process.pid}:${randomUUID()}`;

// Short media heartbeats must not expire the company index while a longer
// pre-dial reservation still owns a slot. Keep it past the latest member lease.
const retainCapacityIndex = `local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', KEYS[1], tonumber(latest[2]) + 60000) end`;

// Transfer a pre-dial reservation without requiring a second company slot.
const bindScript = `-- voice-call-bind
local bound = redis.call('GET', KEYS[4])
if bound then return bound == ARGV[3] and 2 or -1 end
local owner = redis.call('GET', KEYS[2])
if not owner then return 0 end
if string.sub(owner, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. '|' then return -1 end
if redis.call('GET', KEYS[3]) then return -1 end
redis.call('SET', KEYS[3], ARGV[1] .. '|reserved|' .. ARGV[6], 'EX', ARGV[4])
local metadata = redis.call('GET', KEYS[2] .. ':metadata')
if metadata then redis.call('SET', KEYS[3] .. ':metadata', metadata, 'EX', ARGV[4]) end
redis.call('DEL', KEYS[2] .. ':metadata')
redis.call('SET', KEYS[4], ARGV[3], 'EX', ARGV[4])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[5] + ARGV[4] * 1000, ARGV[3])
${retainCapacityIndex}
return 1`;

const releaseReservationScript = `-- voice-call-release-reservation
local bound = redis.call('GET', KEYS[3])
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[2] .. ':metadata')
redis.call('ZREM', KEYS[1], ARGV[2])
if bound then
  local callKey = ARGV[3] .. bound
  local owner = redis.call('GET', callKey)
  if not owner or string.sub(owner, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then
    redis.call('DEL', callKey)
    redis.call('DEL', callKey .. ':metadata')
    redis.call('ZREM', KEYS[1], bound)
  end
end
return 1`;

const acquireScript = `-- voice-call-acquire
local owner = redis.call('GET', KEYS[2])
if owner then
  if string.sub(owner, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '|' then return 2 end
  return -1
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
local expired = redis.call('ZRANGEBYSCORE', ARGV[8], '-inf', ARGV[3])
for _, id in ipairs(expired) do
  redis.call('ZREM', ARGV[7], id)
  redis.call('ZREM', ARGV[8], id)
  redis.call('HDEL', ARGV[9], id)
  redis.call('HDEL', ARGV[12], id)
  redis.call('SET', ARGV[10] .. id .. ':ended', 'expired', 'EX', 3900)
end
if redis.call('ZCARD', ARGV[7]) > 0 then return 0 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
redis.call('SET', KEYS[2], ARGV[1] .. '|reserved|' .. ARGV[2], 'EX', ARGV[4], 'NX')
if ARGV[11] then redis.call('SET', KEYS[2] .. ':metadata', ARGV[11], 'EX', ARGV[4]) end
if not redis.call('GET', KEYS[2]) then return -1 end
redis.call('ZADD', KEYS[1], ARGV[3] + (ARGV[4] * 1000), ARGV[6])
${retainCapacityIndex}
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
  ${retainCapacityIndex}
  return 1
end
return 0`;

const heartbeatScript = `-- voice-call-heartbeat
local expected = ARGV[1] .. '|active|' .. ARGV[2]
if redis.call('GET', KEYS[2]) ~= expected then return 0 end
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2] .. ':metadata', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4] + (ARGV[3] * 1000), ARGV[5])
${retainCapacityIndex}
return 1`;

const releaseScript = `-- voice-call-release
local owner = redis.call('GET', KEYS[2])
if not owner then redis.call('ZREM', KEYS[1], ARGV[3]); return 1 end
local reserved = ARGV[1] .. '|reserved|' .. ARGV[2]
local active = ARGV[1] .. '|active|' .. ARGV[2]
if owner ~= reserved and owner ~= active then return 0 end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[2] .. ':metadata')
redis.call('ZREM', KEYS[1], ARGV[3])
return 1`;

const releaseValidatedScript = `-- voice-call-release-validated
local owner = redis.call('GET', KEYS[2])
if owner and string.sub(owner, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. '|' then return 0 end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[2] .. ':metadata')
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

  async acquire({ tenantId, providerCallId, limit, ttlSeconds = this.ttlSeconds, metadata = {} }) {
    this.#assertReady();
    const [tenantKey, callKey] = keys(tenantId, providerCallId);
    const effectiveLimit = Number(limit);
    if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1) {
      throw new AppError(409, 'Company live-call concurrency is not configured', 'COMPANY_CONCURRENCY_NOT_CONFIGURED');
    }
    const result = Number(await this.redis.eval(acquireScript, 2, tenantKey, callKey,
      tenantId, this.instanceId, this.now(), ttlSeconds, effectiveLimit, providerCallId,
      `${tenantKey}:waiting:order`, `${tenantKey}:waiting:lease`, `${tenantKey}:waiting:state`,
      `${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:call:`, JSON.stringify({ ...metadata, startedAt: this.now() }),
      `${tenantKey}:waiting:metadata`)
      .catch(() => {
        throw new AppError(503, 'Distributed voice-call coordination is unavailable', 'VOICE_COORDINATION_UNAVAILABLE');
      }));
    if (result === 0) {
      throw new AppError(429, 'Company concurrent voice-call limit has been reached', 'VOICE_COMPANY_CONCURRENCY_LIMIT', {
        limit: effectiveLimit,
      });
    }
    if (result < 0) throw new AppError(409, 'Voice call is owned by another company', 'VOICE_CALL_OWNERSHIP_CONFLICT');
    return { acquired: result === 1, idempotent: result === 2, tenantId, providerCallId, limit: effectiveLimit };
  }

  async bindReservation({ tenantId, reservationId, providerCallId, ttlSeconds = this.ttlSeconds }) {
    this.#assertReady();
    const [tenantKey, reservationKey] = keys(tenantId, reservationId);
    const [, callKey] = keys(tenantId, providerCallId);
    const result = Number(await this.redis.eval(bindScript, 4, tenantKey, reservationKey,
      callKey, `${reservationKey}:bound`, tenantId, reservationId, providerCallId, ttlSeconds, this.now(), this.instanceId));
    if (result < 0) throw new AppError(409, 'Call reservation was already bound to another call', 'VOICE_CALL_OWNERSHIP_CONFLICT');
    return { bound: result > 0, acquired: result === 1 };
  }

  async releaseReservation({ tenantId, reservationId }) {
    this.#assertReady();
    const [tenantKey, reservationKey] = keys(tenantId, reservationId);
    const [, callPrefix] = keys(tenantId, '');
    await this.redis.eval(releaseReservationScript, 3, tenantKey, reservationKey,
      `${reservationKey}:bound`, tenantId, reservationId, callPrefix);
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

  async isOwned({ tenantId, providerCallId }) {
    this.#assertReady();
    const [, callKey] = keys(tenantId, providerCallId);
    return Boolean(await this.redis.get(callKey));
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
