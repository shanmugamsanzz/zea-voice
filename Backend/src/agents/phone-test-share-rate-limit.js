import { createHash } from 'node:crypto';
import { redis } from '../infrastructure/redis.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const prefix = `${env.QUEUE_PREFIX}:phone-share:{public-calls}:`;
export const phoneShareLimitScript = `-- phone-share-rate-limit
for i,key in ipairs(KEYS) do
  if tonumber(redis.call('GET',key) or '0') >= tonumber(ARGV[(i-1)*2+1]) then return {i,math.max(1,redis.call('TTL',key))} end
end
for i,key in ipairs(KEYS) do
  local count=redis.call('INCR',key)
  if count==1 then redis.call('EXPIRE',key,ARGV[(i-1)*2+2]) end
end
return {0,0}`;
export async function consumePhoneShareLimits(limits, client = redis) {
  if (client.status && client.status !== 'ready') throw new AppError(503, 'Shared calling is temporarily unavailable.', 'PHONE_SHARE_COORDINATION_UNAVAILABLE');
  let result;
  try {
    result = await client.eval(phoneShareLimitScript, limits.length, ...limits.map(([key]) => prefix + key),
      ...limits.flatMap(([, limit, seconds]) => [limit, seconds]));
  } catch {
    throw new AppError(503, 'Shared calling is temporarily unavailable.', 'PHONE_SHARE_COORDINATION_UNAVAILABLE');
  }
  if (Number(result[0]) > 0) throw new AppError(429, 'Too many requests. Please try again later.', 'PHONE_SHARE_RATE_LIMITED', { retryAfterSeconds: Number(result[1]) });
}
export async function consumePhoneShareReadLimit(ip, client = redis) {
  return consumePhoneShareLimits([[`read-ip:${hash(ip)}`, 1000, 60]], client);
}
export async function consumePhoneShareCallLimits({ linkId, tenantId, phone, ip }, client = redis) {
  return consumePhoneShareLimits([
    [`call-ip:${hash(ip)}`, 60, 3600], [`link-minute:${linkId}`, 10, 60],
    [`link-day:${linkId}`, 100, 86400], [`company-day:${tenantId}`, 200, 86400],
    [`phone-hour:${hash(phone)}`, 20, 3600],
  ], client);
}
