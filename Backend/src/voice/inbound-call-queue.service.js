import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import { voiceCallOwnership } from './call-ownership.service.js';
import { AppError } from '../middleware/errors.js';
import { logger } from '../config/logger.js';

export function inboundQueueKeys(tenantId, callId) {
  const base = `${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:calls`;
  const prefix = `${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:call:`;
  return [base, prefix + callId, `${base}:waiting:order`, `${base}:waiting:lease`,
    `${base}:waiting:state`, `${base}:waiting:sequence`, prefix + callId + ':ended', `${base}:waiting:metadata`];
}

export const inboundAdmissionScript = `-- inbound-call-admit
local now = tonumber(ARGV[3])
local retention = tonumber(ARGV[7]) + tonumber(ARGV[4])
local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  redis.call('HDEL', KEYS[5], id)
  redis.call('HDEL', KEYS[8], id)
  redis.call('SET', ARGV[9] .. id .. ':ended', 'expired', 'EX', retention)
end
if redis.call('GET', KEYS[7]) then return {-2, 0} end
local owner = redis.call('GET', KEYS[2])
if owner then return {2, 0} end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local deadline = tonumber(redis.call('HGET', KEYS[5], ARGV[2]))
if deadline then
  local saved = redis.call('HGET', KEYS[8], ARGV[2])
  if saved then deadline = tonumber(cjson.decode(saved).arrivedAt) + ARGV[7] * 1000 end
  if deadline <= now then
    redis.call('ZREM', KEYS[3], ARGV[2])
    redis.call('ZREM', KEYS[4], ARGV[2])
    redis.call('HDEL', KEYS[5], ARGV[2])
    redis.call('HDEL', KEYS[8], ARGV[2])
    redis.call('SET', KEYS[7], 'expired', 'EX', retention)
    return {-2, 0}
  end
  redis.call('HSET', KEYS[5], ARGV[2], deadline)
end
if not deadline then
  if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[5]) and redis.call('ZCARD', KEYS[3]) == 0 then
    redis.call('SET', KEYS[2], ARGV[1] .. '|reserved|' .. ARGV[10], 'EX', ARGV[4])
    redis.call('ZADD', KEYS[1], now + ARGV[4] * 1000, ARGV[2])
    redis.call('EXPIRE', KEYS[1], ARGV[4] * 2)
    return {1, 0}
  end
  if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[6]) then
    redis.call('SET', KEYS[7], 'full', 'EX', retention)
    return {-1, 0}
  end
  deadline = now + ARGV[7] * 1000
  local sequence = redis.call('INCR', KEYS[6])
  redis.call('ZADD', KEYS[3], sequence, ARGV[2])
  redis.call('HSET', KEYS[5], ARGV[2], deadline)
  redis.call('HSET', KEYS[8], ARGV[2], ARGV[11])
end
local head = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
if head == ARGV[2] and redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[5]) then
  redis.call('ZREM', KEYS[3], ARGV[2])
  redis.call('ZREM', KEYS[4], ARGV[2])
  redis.call('HDEL', KEYS[5], ARGV[2])
  redis.call('HDEL', KEYS[8], ARGV[2])
  redis.call('SET', KEYS[2], ARGV[1] .. '|reserved|' .. ARGV[10], 'EX', ARGV[4])
  redis.call('ZADD', KEYS[1], now + ARGV[4] * 1000, ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[4] * 2)
  return {1, 0}
end
redis.call('ZADD', KEYS[4], math.min(deadline, now + ARGV[8] * 1000), ARGV[2])
for i = 3, 6 do redis.call('EXPIRE', KEYS[i], retention) end
redis.call('EXPIRE', KEYS[8], retention)
return {0, deadline - now}`;

export const inboundCancelScript = `-- inbound-call-cancel
local waiting = redis.call('HEXISTS', KEYS[5], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HDEL', KEYS[5], ARGV[1])
redis.call('HDEL', KEYS[8], ARGV[1])
redis.call('SET', KEYS[7], 'ended', 'EX', ARGV[2])
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[2] .. ':metadata')
redis.call('ZREM', KEYS[1], ARGV[1])
return waiting`;

export class InboundCallQueue {
  constructor(options = {}) {
    this.redis = options.redis ?? redis;
    this.ownership = options.ownership ?? voiceCallOwnership;
    this.now = options.now ?? Date.now;
    this.maxSize = options.maxSize ?? env.VOICE_INBOUND_QUEUE_MAX_SIZE;
    this.maxWaitSeconds = options.maxWaitSeconds ?? env.VOICE_INBOUND_QUEUE_MAX_WAIT_SECONDS;
    this.pollSeconds = options.pollSeconds ?? env.VOICE_INBOUND_QUEUE_POLL_SECONDS;
  }

  async #evaluate(script, identity, args) {
    if (this.redis.status && this.redis.status !== 'ready') {
      throw new AppError(503, 'Inbound queue coordination is unavailable', 'VOICE_COORDINATION_UNAVAILABLE');
    }
    try {
      return await this.redis.eval(script, 8, ...inboundQueueKeys(identity.tenantId, identity.providerCallId), ...args);
    } catch (error) {
      logger.warn({ err: error, stage: 'call.inbound_queue_coordination_failed', tenantId: identity.tenantId }, 'Inbound queue command failed');
      throw new AppError(503, 'Inbound queue coordination is unavailable', 'VOICE_COORDINATION_UNAVAILABLE');
    }
  }

  async admit({ tenantId, providerCallId, limit, maxSize = this.maxSize, maxWaitSeconds = this.maxWaitSeconds, metadata = {} }) {
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1) {
      throw new AppError(409, 'Company live-call concurrency is not configured', 'COMPANY_CONCURRENCY_NOT_CONFIGURED');
    }
    const prefix = `${env.QUEUE_PREFIX}:voice:tenant:{${tenantId}}:call:`;
    const [result, remainingMs] = await this.#evaluate(inboundAdmissionScript, { tenantId, providerCallId },
      [tenantId, providerCallId, this.now(), 300, limit, maxSize, maxWaitSeconds,
        Math.max(30, this.pollSeconds * 3), prefix, this.ownership.instanceId,
        JSON.stringify({ ...metadata, arrivedAt: this.now() })]);
    return { status: result > 0 ? 'admitted' : result === 0 ? 'waiting' : result === -1 ? 'full' : 'ended',
      acquired: result === 1, remainingMs: Number(remainingMs), tenantId, providerCallId };
  }

  async cancel({ tenantId, providerCallId }) {
    return Number(await this.#evaluate(inboundCancelScript, { tenantId, providerCallId },
      [providerCallId, 3900])) === 1;
  }
}

export const inboundCallQueue = new InboundCallQueue();

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function buildInboundQueueXml(admission, answerUrl, options = {}) {
  if (admission.status !== 'waiting') {
    const message = admission.status === 'full' ? 'All agents are busy and the waiting queue is full. Please call again later.'
      : 'We could not connect you within the waiting time. Please call again later.';
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>${message}</Speak><Hangup/></Response>`;
  }
  const seconds = Math.max(1, Math.min(options.pollSeconds ?? env.VOICE_INBOUND_QUEUE_POLL_SECONDS,
    Math.ceil(admission.remainingMs / 1000)));
  const publicBase = String(options.publicBaseUrl ?? env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  if (!publicBase) throw new AppError(503, 'PUBLIC_BASE_URL is not configured', 'PUBLIC_URL_NOT_CONFIGURED');
  const musicUrl = new URL(`${publicBase}/webhooks/plivo/hold-music.wav`);
  musicUrl.searchParams.set('seconds', seconds);
  const redirect = new URL(answerUrl);
  redirect.searchParams.set('queue_poll', '1');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escapeXml(musicUrl)}</Play><Redirect method="POST">${escapeXml(redirect)}</Redirect></Response>`;
}

// Original, small PCM music clips served locally; no external media dependency.
export function createHoldMusic(seconds) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  const notes = [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 349.23];
  for (let i = 0; i < samples; i++) {
    const time = i / sampleRate;
    const phase = time % 0.5;
    const envelope = Math.min(1, phase / 0.025) * Math.min(1, (0.5 - phase) / 0.08);
    const frequency = notes[Math.floor(time * 2) % notes.length];
    wav.writeInt16LE(Math.round(2600 * envelope * Math.sin(2 * Math.PI * frequency * time)), 44 + i * 2);
  }
  return wav;
}
