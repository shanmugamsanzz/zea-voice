import { env } from '../config/env.js';
import { measureExternalProvider } from '../performance/performance-context.js';
import { tenantCollectionName } from './tenant-isolation.js';

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
      signal: AbortSignal.timeout(env.QDRANT_REQUEST_TIMEOUT_MS),
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
    ['knowledge_base_id', 'keyword'],
    ['document_id', 'keyword'],
    ['document_version_id', 'keyword'],
    ['record_type', 'keyword'],
    ['category', 'keyword'],
    ['agent_usage', 'keyword'],
    ['publication_revision', 'integer'],
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

export async function searchTenantPoints(tenantId, vector, {
  knowledgeBases,
  usageDirection,
  limit = env.RAG_RUNTIME_TOP_K,
  scoreThreshold = env.RAG_RUNTIME_MIN_SCORE,
} = {}) {
  if (!Array.isArray(vector) || vector.length !== env.QDRANT_VECTOR_SIZE
    || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`A numeric ${env.QDRANT_VECTOR_SIZE}-dimension query vector is required`);
  }
  if (!Array.isArray(knowledgeBases) || knowledgeBases.length === 0) return [];
  if (!['inbound', 'outbound'].includes(usageDirection)) {
    throw new TypeError('usageDirection must be inbound or outbound');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('limit must be between 1 and 10');
  }

  const tenant = tenantId.toLowerCase();
  const revisionConditions = knowledgeBases.map(({ id, publicationRevision }) => {
    if (typeof id !== 'string' || !Number.isInteger(publicationRevision) || publicationRevision < 1) {
      throw new TypeError('Every Knowledge Base filter requires an id and positive publicationRevision');
    }
    return {
      must: [
        { key: 'knowledge_base_id', match: { value: id.toLowerCase() } },
        { key: 'publication_revision', match: { value: publicationRevision } },
      ],
    };
  });
  const collectionName = collectionForTenant(tenant);
  const payload = await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/search`, {
    method: 'POST',
    operation: 'search-points',
    body: JSON.stringify({
      vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: 'tenant_id', match: { value: tenant } },
          { key: 'agent_usage', match: { any: [usageDirection.toUpperCase(), 'BOTH'] } },
          { key: 'record_type', match: { any: ['FAQ', 'KNOWLEDGE_CHUNK'] } },
          { should: revisionConditions },
        ],
      },
    }),
  });
  if (!Array.isArray(payload?.result)) throw new Error('Qdrant returned an invalid search response');
  return payload.result;
}

export async function deleteTenantPointsByKnowledgeBase(
  tenantId,
  knowledgeBaseId,
  { publicationRevision = undefined, revisionMode = 'all' } = {},
) {
  const collectionName = collectionForTenant(tenantId);
  const must = [
    { key: 'tenant_id', match: { value: tenantId.toLowerCase() } },
    { key: 'knowledge_base_id', match: { value: knowledgeBaseId.toLowerCase() } },
  ];
  if (publicationRevision !== undefined) {
    if (!Number.isInteger(publicationRevision) || publicationRevision < 1) {
      throw new TypeError('publicationRevision must be a positive integer');
    }
    if (revisionMode === 'equal') {
      must.push({ key: 'publication_revision', match: { value: publicationRevision } });
    } else if (revisionMode === 'older') {
      must.push({ key: 'publication_revision', range: { lt: publicationRevision } });
    } else {
      throw new TypeError('revisionMode must be equal or older when publicationRevision is provided');
    }
  } else if (revisionMode !== 'all') {
    throw new TypeError('revisionMode must be all when publicationRevision is omitted');
  }
  try {
    await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/delete?wait=true`, {
      method: 'POST',
      operation: 'delete-knowledge-base-points',
      body: JSON.stringify({ filter: { must } }),
    });
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  return { deleted: true };
}

async function deleteTenantPointsByEntity(tenantId, field, entityId, operation) {
  const tenant = tenantId.toLowerCase();
  const collectionName = collectionForTenant(tenant);
  try {
    await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/delete?wait=true`, {
      method: 'POST',
      operation,
      body: JSON.stringify({
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenant } },
            { key: field, match: { value: entityId.toLowerCase() } },
          ],
        },
      }),
    });
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  return { deleted: true };
}

export function deleteTenantPointsByDocument(tenantId, documentId) {
  return deleteTenantPointsByEntity(tenantId, 'document_id', documentId, 'delete-document-points');
}

export function deleteTenantPointsByDocumentVersion(tenantId, documentVersionId) {
  return deleteTenantPointsByEntity(
    tenantId, 'document_version_id', documentVersionId, 'delete-document-version-points',
  );
}

export async function deleteTenantCollection(tenantId) {
  const collectionName = collectionForTenant(tenantId);
  try {
    await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}`, {
      method: 'DELETE',
      operation: 'delete-collection',
    });
    return { collectionName, deleted: true };
  } catch (error) {
    if (error.statusCode === 404) return { collectionName, deleted: false };
    throw error;
  }
}
