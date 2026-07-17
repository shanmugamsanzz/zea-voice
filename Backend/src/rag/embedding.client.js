import { env } from '../config/env.js';
import { measureExternalProvider } from '../performance/performance-context.js';
import { embeddingModelSpec, prepareEmbeddingText } from './model-spec.js';

function embeddingEndpoint() {
  return `${env.EMBEDDING_BASE_URL.replace(/\/$/, '')}/v1/embeddings`;
}

function validateVector(vector) {
  if (!Array.isArray(vector) || vector.length !== embeddingModelSpec.dimensions) {
    throw new Error(`Embedding service returned an invalid vector dimension; expected ${embeddingModelSpec.dimensions}`);
  }
  if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Embedding service returned a non-numeric vector');
  }
  return vector;
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code ?? payload?.error ?? payload?.code ?? 'EMBEDDING_REQUEST_FAILED';
    throw new Error(`Embedding service request failed with HTTP ${response.status} (${String(code)})`);
  }
  return payload;
}

export async function embedTexts(values, { kind = 'passage' } = {}) {
  if (!env.RAG_ENABLED) {
    throw new Error('RAG is disabled');
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('At least one embedding input is required');
  }

  const input = values.map((value) => prepareEmbeddingText(value, kind));
  const payload = await measureExternalProvider('embedding', 'embed', async () => {
    const response = await fetch(embeddingEndpoint(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.EMBEDDING_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, input }),
      signal: AbortSignal.timeout(env.EMBEDDING_REQUEST_TIMEOUT_MS),
    });
    return parseResponse(response);
  });

  if (!Array.isArray(payload?.data) || payload.data.length !== input.length) {
    throw new Error('Embedding service returned an unexpected response count');
  }

  return [...payload.data]
    .sort((left, right) => left.index - right.index)
    .map((entry) => validateVector(entry.embedding));
}

export async function embedQuery(value) {
  return (await embedTexts([value], { kind: 'query' }))[0];
}

export async function embedPassages(values) {
  return embedTexts(values, { kind: 'passage' });
}

export async function checkEmbedding() {
  const startedAt = performance.now();
  const vector = await embedQuery('Zea Voice embedding readiness check');
  return {
    ok: true,
    latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
    model: embeddingModelSpec.id,
    dimensions: vector.length,
  };
}

function percentile(sortedValues, percentileValue) {
  const index = Math.min(sortedValues.length - 1, Math.ceil(percentileValue * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

export async function benchmarkEmbedding({ iterations = env.EMBEDDING_BENCHMARK_ITERATIONS } = {}) {
  await embedQuery('Warm up the Zea Voice embedding model');
  const durations = [];

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await embedQuery(`Hospital package price benchmark query ${index + 1}`);
    durations.push(Math.round((performance.now() - startedAt) * 100) / 100);
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const averageMs = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const p95Ms = percentile(sorted, 0.95);
  return {
    model: embeddingModelSpec.id,
    dimensions: embeddingModelSpec.dimensions,
    iterations,
    minMs: sorted[0],
    averageMs: Math.round(averageMs * 100) / 100,
    p50Ms: percentile(sorted, 0.5),
    p95Ms,
    maxMs: sorted.at(-1),
    targetP95Ms: env.EMBEDDING_BENCHMARK_TARGET_P95_MS,
    meetsTarget: p95Ms <= env.EMBEDDING_BENCHMARK_TARGET_P95_MS,
  };
}
