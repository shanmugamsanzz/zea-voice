import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getB2Object } from '../rag/b2.client.js';

const cache = new Map();
let cachedBytes = 0;

function remember(key, audio, limit) {
  if (audio.length > limit) return;
  while (cachedBytes + audio.length > limit && cache.size) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cachedBytes -= oldest.audio.length;
  }
  cache.set(key, { audio, accessedAt: Date.now() });
  cachedBytes += audio.length;
}

export async function loadRuntimeAmbience(runtimeProfile, dependencies = {}) {
  const ambience = runtimeProfile?.ambience;
  if (!ambience?.normalizedObjectKey || ambience.status !== 'active' || ambience.storageStatus !== 'ready') return null;
  const key = `${runtimeProfile.agent.tenantId}:${runtimeProfile.agent.workspaceId}:${ambience.id}:${ambience.normalizedObjectKey}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return { ...ambience, audio: cached.audio, cacheHit: true };
  }
  const getObject = dependencies.getObject ?? getB2Object;
  try {
    const object = await getObject({
      key: ambience.normalizedObjectKey,
      versionId: ambience.normalizedStorageVersionId ?? undefined,
      maxBytes: Math.min(env.AMBIENCE_RUNTIME_CACHE_MAX_BYTES, 4_000_000),
    });
    if (!object.body?.length) return null;
    remember(key, object.body, env.AMBIENCE_RUNTIME_CACHE_MAX_BYTES);
    return { ...ambience, audio: object.body, cacheHit: false };
  } catch (error) {
    (dependencies.log ?? logger).warn({
      err: error,
      stage: 'ambience.runtime_load_failed',
      agentId: runtimeProfile.agent.id,
      ambienceAssetId: ambience.id,
    }, 'Assigned ambience could not be loaded; call will continue without background sound');
    return null;
  }
}

export function clearRuntimeAmbienceCache() {
  cache.clear();
  cachedBytes = 0;
}
