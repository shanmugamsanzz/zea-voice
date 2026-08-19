import { env } from '../config/env.js';
import { measureExternalProvider } from '../performance/performance-context.js';
import { requireEntityId, requireTenantId, tenantCollectionName } from './tenant-isolation.js';

// Discovery is intentionally wider than the final evidence window. The
// hybrid ranker reduces this set to three-to-five hydrated records, while a
// wider Qdrant window prevents clusters of near-duplicate records from hiding
// authoritative Catalog or Conversation evidence before reranking.
export const QDRANT_SEARCH_LIMIT_MAX = 30;

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
    ['knowledge_base_id', 'keyword'],
    ['document_id', 'keyword'],
    ['document_version_id', 'keyword'],
    ['record_type', 'keyword'],
    ['document_type', 'keyword'],
    ['category', 'keyword'],
    ['agent_usage', 'keyword'],
    ['assigned_agent_ids', 'keyword'],
    ['language', 'keyword'],
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

export async function countTenantPointsByKnowledgeBaseRevision(tenantId, knowledgeBaseId, publicationRevision) {
  const tenant = requireTenantId(tenantId);
  const knowledgeBase = requireEntityId(knowledgeBaseId, 'knowledgeBaseId');
  if (!Number.isInteger(publicationRevision) || publicationRevision < 1) {
    throw new TypeError('publicationRevision must be a positive integer');
  }
  const collectionName = collectionForTenant(tenant);
  const filter = { must: [
    { key: 'tenant_id', match: { value: tenant } },
    { key: 'knowledge_base_id', match: { value: knowledgeBase } },
    { key: 'publication_revision', match: { value: publicationRevision } },
  ] };
  const counted = await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/count`, {
    method: 'POST',
    operation: 'count-publication-revision-points',
    body: JSON.stringify({ filter, exact: true }),
  });
  const count = counted?.result?.count;
  if (!Number.isInteger(count) || count < 0) throw new Error('Qdrant returned an invalid publication count');
  return { count, verified: true, filter };
}

export async function searchTenantPoints(tenantId, vector, {
  knowledgeBases,
  usageDirection,
  agentId,
  abortSignal,
  limit = env.RAG_RUNTIME_TOP_K,
  scoreThreshold = env.RAG_RUNTIME_MIN_SCORE,
  recordTypes = ['FAQ', 'KNOWLEDGE_CHUNK'],
} = {}) {
  if (!Array.isArray(vector) || vector.length !== env.QDRANT_VECTOR_SIZE
    || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`A numeric ${env.QDRANT_VECTOR_SIZE}-dimension query vector is required`);
  }
  if (!Array.isArray(knowledgeBases) || knowledgeBases.length === 0) return [];
  if (!['inbound', 'outbound'].includes(usageDirection)) {
    throw new TypeError('usageDirection must be inbound or outbound');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > QDRANT_SEARCH_LIMIT_MAX) {
    throw new TypeError(`limit must be between 1 and ${QDRANT_SEARCH_LIMIT_MAX}`);
  }
  if (!Array.isArray(recordTypes) || recordTypes.length === 0
    || recordTypes.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('recordTypes must contain at least one record type');
  }
  const normalizedRecordTypes = [...new Set(recordTypes.map((value) => value.trim().toUpperCase()))];

  const tenant = tenantId.toLowerCase();
  // Agent assignment is mutable runtime state, while Qdrant payloads are an
  // immutable snapshot of the assignment at publication time. Filtering on
  // assigned_agent_ids here makes a correctly assigned, published KB
  // undiscoverable whenever an assignment changes without a republish.
  //
  // Current assignment is enforced twice by the caller: the active scope is
  // loaded from PostgreSQL before this search, and every selected record is
  // hydrated through the same current assignment/revision scope before it can
  // become evidence. Keep Qdrant discovery scoped to tenant + exact KB
  // revision + direction + record type; never trust discovery as authority.
  if (agentId !== undefined) requireEntityId(agentId, 'agentId');
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
    signal: abortSignal,
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
          { key: 'record_type', match: { any: normalizedRecordTypes } },
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
  const tenant = requireTenantId(tenantId);
  const knowledgeBase = requireEntityId(knowledgeBaseId, 'knowledgeBaseId');
  const collectionName = collectionForTenant(tenant);
  const must = [
    { key: 'tenant_id', match: { value: tenant } },
    { key: 'knowledge_base_id', match: { value: knowledgeBase } },
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
    return { deleted: true, verified: true, remainingCount: 0, collectionMissing: true };
  }
  let counted;
  try {
    counted = await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/count`, {
      method: 'POST',
      operation: 'verify-knowledge-base-points-deleted',
      body: JSON.stringify({ filter: { must }, exact: true }),
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return { deleted: true, verified: true, remainingCount: 0, collectionMissing: true };
    }
    throw error;
  }
  const remainingCount = counted?.result?.count;
  if (!Number.isInteger(remainingCount) || remainingCount < 0) {
    throw new Error('Qdrant returned an invalid Knowledge Base deletion verification count');
  }
  if (remainingCount !== 0) {
    const error = new Error(`Qdrant still contains ${remainingCount} matching Knowledge Base point(s)`);
    error.code = 'QDRANT_KNOWLEDGE_DELETE_INCOMPLETE';
    error.remainingCount = remainingCount;
    throw error;
  }
  return { deleted: true, verified: true, remainingCount, collectionMissing: false };
}

async function deleteTenantPointsByEntity(
  tenantId,
  field,
  entityId,
  operation,
  { knowledgeBaseId = undefined } = {},
) {
  const tenant = requireTenantId(tenantId);
  const entity = requireEntityId(entityId, field);
  const collectionName = collectionForTenant(tenant);
  const must = [
    { key: 'tenant_id', match: { value: tenant } },
    { key: field, match: { value: entity } },
  ];
  if (knowledgeBaseId !== undefined) {
    must.splice(1, 0, {
      key: 'knowledge_base_id',
      match: { value: requireEntityId(knowledgeBaseId, 'knowledgeBaseId') },
    });
  }
  try {
    await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/delete?wait=true`, {
      method: 'POST',
      operation,
      body: JSON.stringify({ filter: { must } }),
    });
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    return { deleted: true, verified: true, remainingCount: 0, collectionMissing: true };
  }
  let counted;
  try {
    counted = await qdrantFetch(`/collections/${encodeURIComponent(collectionName)}/points/count`, {
      method: 'POST',
      operation: `verify-${operation}`,
      body: JSON.stringify({ filter: { must }, exact: true }),
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return { deleted: true, verified: true, remainingCount: 0, collectionMissing: true };
    }
    throw error;
  }
  const remainingCount = counted?.result?.count;
  if (!Number.isInteger(remainingCount) || remainingCount < 0) {
    throw new Error('Qdrant returned an invalid entity deletion verification count');
  }
  if (remainingCount !== 0) {
    const error = new Error(`Qdrant still contains ${remainingCount} matching ${field} point(s)`);
    error.code = 'QDRANT_KNOWLEDGE_DELETE_INCOMPLETE';
    error.remainingCount = remainingCount;
    throw error;
  }
  return { deleted: true, verified: true, remainingCount, collectionMissing: false };
}

export function deleteTenantPointsByDocument(tenantId, documentId, options = {}) {
  return deleteTenantPointsByEntity(
    tenantId, 'document_id', documentId, 'delete-document-points', options,
  );
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
