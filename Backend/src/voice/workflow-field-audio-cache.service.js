import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function cacheKey(runtimeProfile, descriptor) {
  const tts = runtimeProfile.providers.tts;
  const identity = JSON.stringify({
    tenantId: runtimeProfile.agent.tenantId,
    agentId: runtimeProfile.agent.id,
    providerId: tts.providerId,
    modelId: tts.modelId,
    voiceId: runtimeProfile.agent.voiceId ?? tts.effectiveSettings?.voiceId,
    language: descriptor.language ?? runtimeProfile.agent.language,
    settings: tts.effectiveSettings,
    pronunciation: runtimeProfile.pronunciation ?? null,
    workflowRecordId: descriptor.workflowRecordId,
    knowledgeBaseId: descriptor.knowledgeBaseId,
    publicationRevision: descriptor.publicationRevision,
    toolId: descriptor.toolId,
    fieldKey: descriptor.fieldKey,
    configuredQuestion: descriptor.configuredQuestion,
  });
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return `${env.QUEUE_PREFIX}:voice:workflow-field:${runtimeProfile.agent.tenantId}:${digest}`;
}

async function bounded(operation, timeoutMs) {
  let timer;
  return Promise.race([
    operation,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

export class WorkflowFieldAudioCache {
  constructor(options = {}) {
    this.redis = options.redis ?? redis;
    this.timeoutMs = options.timeoutMs ?? env.VOICE_WELCOME_CACHE_TIMEOUT_MS;
    this.ttlSeconds = options.ttlSeconds ?? env.VOICE_WELCOME_CACHE_TTL_SECONDS;
    this.maxBytes = options.maxBytes ?? env.VOICE_WELCOME_CACHE_MAX_BYTES;
  }

  async get(runtimeProfile, descriptor) {
    try {
      if (this.redis.status && this.redis.status !== 'ready') return null;
      const encoded = await bounded(this.redis.get(cacheKey(runtimeProfile, descriptor)), this.timeoutMs);
      if (!encoded) return null;
      const parsed = JSON.parse(encoded);
      const speech = cleanText(parsed?.speech, 4_000);
      const audio = parsed?.audio ? Buffer.from(parsed.audio, 'base64') : null;
      if (!speech || (audio && (!audio.length || audio.length > this.maxBytes))) return null;
      return Object.freeze({ speech, audio });
    } catch { return null; }
  }

  async set(runtimeProfile, descriptor, speech, audio = null) {
    const normalizedSpeech = cleanText(speech, 4_000);
    if (!normalizedSpeech || (audio && (!Buffer.isBuffer(audio)
      || !audio.length || audio.length > this.maxBytes))) return false;
    try {
      if (this.redis.status && this.redis.status !== 'ready') return false;
      const result = await bounded(this.redis.set(
        cacheKey(runtimeProfile, descriptor),
        JSON.stringify({ speech: normalizedSpeech, audio: audio?.toString('base64') ?? null }),
        'EX', this.ttlSeconds,
      ), this.timeoutMs);
      return result === 'OK';
    } catch { return false; }
  }
}

export const workflowFieldAudioCache = new WorkflowFieldAudioCache();
