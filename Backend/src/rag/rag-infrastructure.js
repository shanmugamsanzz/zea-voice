import { env } from '../config/env.js';
import { checkB2 } from './b2.client.js';
import { checkEmbedding } from './embedding.client.js';
import { checkQdrant } from './qdrant.client.js';

let cachedHealth;
let cachedAt = 0;

function settledHealth(result) {
  if (result.status === 'fulfilled') return result.value;
  return { ok: false, error: result.reason?.message ?? 'Health check failed' };
}

export async function checkRagInfrastructure({ force = false } = {}) {
  if (!env.RAG_ENABLED) {
    return { ok: true, enabled: false };
  }
  if (!force && cachedHealth && Date.now() - cachedAt < env.RAG_HEALTH_CACHE_TTL_MS) {
    return cachedHealth;
  }

  const [embedding, qdrant, b2] = await Promise.allSettled([
    checkEmbedding(),
    checkQdrant(),
    env.B2_SKIP_STARTUP_CHECK ? Promise.resolve({ ok: true, skipped: true }) : checkB2(),
  ]);
  const services = {
    embedding: settledHealth(embedding),
    qdrant: settledHealth(qdrant),
    b2: settledHealth(b2),
  };
  const health = {
    ok: Object.values(services).every((service) => service.ok),
    enabled: true,
    services,
  };
  cachedHealth = health;
  cachedAt = Date.now();
  return health;
}

export async function assertRagInfrastructure() {
  const health = await checkRagInfrastructure({ force: true });
  if (!health.ok) {
    const failed = Object.entries(health.services)
      .filter(([, service]) => !service.ok)
      .map(([name]) => name);
    throw new Error(`RAG infrastructure check failed: ${failed.join(', ')}`);
  }
  return health;
}
