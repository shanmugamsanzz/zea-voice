import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import { requireEntityId, requireTenantId } from '../rag/tenant-isolation.js';

export function knowledgeMapCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:knowledge-map:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function buildCompactKnowledgeMap(job, records) {
  return {
    version: 1,
    tenantId: requireTenantId(job.tenant_id),
    knowledgeBaseId: requireEntityId(job.knowledge_base_id, 'knowledgeBaseId'),
    publicationRevision: job.targetRevision,
    usageDirection: String(job.knowledge_base_usage ?? 'both').toLowerCase(),
    assignedAgentIds: [...(job.assigned_agent_ids ?? [])],
    recordCount: records.length,
    records: records.map((record) => ({
      id: record.record_id,
      type: String(record.record_type).toUpperCase(),
      documentId: record.document_id,
      documentVersionId: record.document_version_id,
      language: record.language ?? 'und',
      usageDirection: String(record.usage_direction ?? job.knowledge_base_usage ?? 'both').toLowerCase(),
      label: record.entity_name ?? record.question ?? null,
      summary: String(record.answer ?? record.content ?? '').replace(/\s+/gu, ' ').trim().slice(0, 700) || null,
      category: record.entity_category ?? null,
      metadata: record.entity_metadata && typeof record.entity_metadata === 'object'
        ? record.entity_metadata : {},
    })),
  };
}

export async function cacheCompactKnowledgeMap(job, records, cache = redis) {
  const map = buildCompactKnowledgeMap(job, records);
  const key = knowledgeMapCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision);
  if (!cache || (cache.status && cache.status !== 'ready')) {
    throw new Error('Redis is not ready to cache the published knowledge map');
  }
  await cache.set(
    key,
    JSON.stringify(map),
    'EX',
    Math.max(env.RAG_RUNTIME_PROFILE_CACHE_TTL_SECONDS, 3600),
  );
  return { key, map };
}
