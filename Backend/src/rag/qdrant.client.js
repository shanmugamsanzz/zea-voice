import { env } from '../config/env.js';
import { measureExternalProvider } from '../performance/performance-context.js';
import { requireEntityId, requireTenantId, tenantCollectionName } from './tenant-isolation.js';

function qdrantBaseUrl() {
  return env.QDRANT_URL.replace(/\/$/, '');
}

async function qdrantFetch(path, options = {}) {
  return measureExternalProvider('qdrant', options.operation ?? 'request', async () => {
    const response = await fetch(`${qdrantBaseUrl()}${path}`, {
      ...options,
      headers: {
        'api-key': env.QDRANT_API_KEY,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(env.QDRANT_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(env.QDRANT_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Qdrant request failed with HTTP ${response.status} (${payload?.status?.error ?? 'QDRANT_REQUEST_FAILED'})`);
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  });
}

export function collectionForTenant(tenantId) {
  return tenantCollectionName(tenantId);
}

export async function checkQdrant() {
  const startedAt = performance.now();
  await qdrantFetch('/collections', { operation: 'health' });
  return { ok: true, latencyMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}

export async function ensureTenantCollection(tenantId) {
  const collectionName = collectionForTenant(tenantId);
  let created = false;
  try {
    const existing = await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}`, {
      operation: 'get-collection',
    });
    const vectors = existing.result?.config?.params?.vectors;
    if (vectors?.size !== env.QDRANT_VECTOR_SIZE || vectors?.distance !== env.QDRANT_DISTANCE) {
      throw new Error(`Qdrant collection ${collectionName} does not match the frozen vector configuration`);
    }
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    try {
      await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}`, {
        method: 'PUT',
        operation: 'create-collection',
        body: JSON.stringify({
          vectors: { size: env.QDRANT_VECTOR_SIZE, distance: env.QDRANT_DISTANCE },
          on_disk_payload: true,
        }),
      });
      created = true;
    } catch (createError) {
      if (createError.statusCode !== 409) throw createError;
    }
  }

  const indexes = [
    ['tenant_id', 'keyword'],
    ['document_id', 'keyword'],
    ['language', 'keyword'],
    ['agent_id', 'keyword'],
    ['source_kind', 'keyword'],
    ['filename', 'keyword'],
    ['chunk_index', 'integer'],
    ['content_hash', 'keyword'],
    ['uploaded_at', 'datetime'],
  ];
  for (const [fieldName, fieldSchema] of indexes) {
    try {
      await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/index?wait=true`, {
        method: 'PUT',
        operation: 'create-payload-index',
        body: JSON.stringify({ field_name: fieldName, field_schema: fieldSchema }),
      });
    } catch (error) {
      const alreadyExists = [400, 409].includes(error.statusCode)
        && JSON.stringify(error.payload ?? '').toLowerCase().includes('already exists');
      if (!alreadyExists) throw error;
    }
  }
  return { collectionName, created };
}

export async function upsertTenantPoints(tenantId, points) {
  if (!Array.isArray(points) || points.length === 0) return { count: 0 };
  const collectionName = collectionForTenant(tenantId);
  await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points?wait=true`, {
    method: 'PUT',
    operation: 'upsert-points',
    body: JSON.stringify({ points }),
  });
  return { count: points.length };
}

function agentDocumentFilter(tenantId, agentId, documentId = undefined) {
  const must = [
    { key: 'tenant_id', match: { value: requireTenantId(tenantId) } },
    { key: 'agent_id', match: { value: requireEntityId(agentId, 'agentId') } },
    { key: 'source_kind', match: { value: 'agent_text_document' } },
  ];
  if (documentId !== undefined) {
    must.push({ key: 'document_id', match: { value: requireEntityId(documentId, 'documentId') } });
  }
  return Object.freeze({ must: Object.freeze(must) });
}

export async function scrollTenantAgentDocumentPoints(
  tenantId, agentId, { documentId = undefined, abortSignal = undefined } = {},
) {
  const collectionName = collectionForTenant(tenantId);
  const filter = agentDocumentFilter(tenantId, agentId, documentId);
  const points = [];
  let offset = null;
  do {
    let payload;
    try {
      payload = await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/scroll`, {
        method: 'POST', operation: 'scroll-agent-document-points', signal: abortSignal,
        body: JSON.stringify({
          filter, limit: 256, with_payload: true, with_vector: false,
          ...(offset === null ? {} : { offset }),
        }),
      });
    } catch (error) {
      if (error.statusCode === 404) return [];
      throw error;
    }
    if (!Array.isArray(payload?.result?.points)) {
      throw new Error('Qdrant returned an invalid document scroll response');
    }
    points.push(...payload.result.points);
    offset = payload.result.next_page_offset ?? null;
    if (points.length > 100_000) throw new Error('Qdrant document listing exceeded its safety limit');
  } while (offset !== null);
  return points;
}

export async function deleteTenantAgentDocumentPoints(tenantId, agentId, documentId) {
  const collectionName = collectionForTenant(tenantId);
  const filter = agentDocumentFilter(tenantId, agentId, documentId);
  try {
    await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/delete?wait=true`, {
      method: 'POST', operation: 'delete-agent-document-points',
      body: JSON.stringify({ filter }),
    });
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    return { deleted: true, verified: true, remainingCount: 0, collectionMissing: true };
  }
  const remaining = await scrollTenantAgentDocumentPoints(
    tenantId, agentId, { documentId },
  );
  if (remaining.length) {
    const error = new Error(`Qdrant still contains ${remaining.length} document point(s)`);
    error.code = 'QDRANT_AGENT_DOCUMENT_DELETE_INCOMPLETE';
    error.remainingCount = remaining.length;
    throw error;
  }
  return { deleted: true, verified: true, remainingCount: 0, collectionMissing: false };
}

export async function searchTenantAgentDocumentPoints(tenantId, agentId, vector, {
  limit = 3,
  scoreThreshold = env.RAG_RUNTIME_MIN_SCORE,
  abortSignal = undefined,
} = {}) {
  if (!Array.isArray(vector) || vector.length !== env.QDRANT_VECTOR_SIZE
    || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`A numeric ${env.QDRANT_VECTOR_SIZE}-dimension query vector is required`);
  }
  if (![2, 3].includes(limit)) throw new TypeError('Agent document search limit must be 2 or 3');
  const collectionName = collectionForTenant(tenantId);
  try {
    const payload = await qdrantFetch(
      `/collections/${encodeURIComponent(collectionName)}/points/search`, {
        method: 'POST', operation: 'search-agent-document-points', signal: abortSignal,
        body: JSON.stringify({
          vector,
          filter: agentDocumentFilter(tenantId, agentId),
          limit,
          score_threshold: scoreThreshold,
          with_payload: true,
          with_vector: false,
        }),
      },
    );
    if (!Array.isArray(payload?.result)) {
      throw new Error('Qdrant returned an invalid agent document search response');
    }
    return payload.result;
  } catch (error) {
    if (error.statusCode === 404) return [];
    throw error;
  }
}
