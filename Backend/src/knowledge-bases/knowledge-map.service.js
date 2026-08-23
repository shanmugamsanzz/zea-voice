import { redis } from '../infrastructure/redis.js';
import { requireEntityId, requireTenantId } from '../rag/tenant-isolation.js';
import { KNOWLEDGE_PUBLICATION_BUNDLE_VERSION } from '../knowledge-engine/publication-index-builder.js';

const documentTypeByRecordType = Object.freeze({
  faq: 'faq', knowledge_chunk: 'general_knowledge', catalog_item: 'catalog',
  workflow_rule: 'workflow_rules', conversation_node: 'conversation_script',
});

export function knowledgeMapCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:knowledge-map:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function sparseIndexCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:bm25:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function evidenceCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:evidence:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function entityIndexCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:entity-index:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function routeIndexCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:route-index:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function answerCardsCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:answer-cards:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function publicationManifestCacheKey(tenantId, knowledgeBaseId, publicationRevision) {
  return `zea:rag:publication-manifest:${requireTenantId(tenantId)}:${requireEntityId(knowledgeBaseId, 'knowledgeBaseId')}:${publicationRevision}`;
}

export function tenantKnowledgeGenerationCacheKey(tenantId) {
  return `zea:rag:generation:${requireTenantId(tenantId)}`;
}

function sparseTokens(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

export function buildRevisionSparseIndex(job, records) {
  const documents = records.map((record) => ({
    id: record.record_id,
    recordType: String(record.record_type).toUpperCase(),
    tenantId: requireTenantId(job.tenant_id),
    knowledgeBaseId: requireEntityId(job.knowledge_base_id, 'knowledgeBaseId'),
    documentId: requireEntityId(record.document_id, 'documentId'),
    documentVersionId: requireEntityId(record.document_version_id, 'documentVersionId'),
    publicationRevision: job.targetRevision,
    language: String(record.language ?? 'und').toLowerCase(),
    usageDirection: String(record.usage_direction ?? job.knowledge_base_usage ?? 'both').toLowerCase(),
    pageNumber: record.source_page_start ?? null,
    pageEnd: record.source_page_end ?? record.source_page_start ?? null,
    documentName: record.document_name ?? null,
    documentDisplayName: record.document_display_name ?? null,
    documentType: record.document_type ?? documentTypeByRecordType[record.record_type],
    sourceSection: record.source_section ?? null,
    sourceLineStart: record.source_line_start ?? null,
    sourceLineEnd: record.source_line_end ?? null,
    content: String(record.answer ?? record.content ?? '').trim(),
    tokens: sparseTokens([
      record.question, record.entity_name, record.entity_category,
      ...(record.entity_aliases ?? []), ...(record.entity_category_aliases ?? []),
      ...(record.publicationAliases ?? []), ...(record.publicationSttForms ?? []), record.content,
    ].filter(Boolean).join(' ')),
  }));
  const documentFrequency = {};
  for (const document of documents) {
    for (const token of new Set(document.tokens)) documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
  }
  return {
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    algorithm: 'bm25',
    tenantId: requireTenantId(job.tenant_id),
    knowledgeBaseId: requireEntityId(job.knowledge_base_id, 'knowledgeBaseId'),
    publicationRevision: job.targetRevision,
    documentCount: documents.length,
    documentFrequency,
    documents,
  };
}

export function buildCompactKnowledgeMap(job, records) {
  return {
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    tenantId: requireTenantId(job.tenant_id),
    knowledgeBaseId: requireEntityId(job.knowledge_base_id, 'knowledgeBaseId'),
    publicationRevision: job.targetRevision,
    usageDirection: String(job.knowledge_base_usage ?? 'both').toLowerCase(),
    assignedAgentIds: [...(job.assigned_agent_ids ?? [])],
    recordCount: records.length,
    records: records.map((record) => ({
      id: record.record_id,
      type: String(record.record_type).toUpperCase(),
      documentType: record.document_type ?? documentTypeByRecordType[record.record_type],
      documentId: record.document_id,
      documentVersionId: record.document_version_id,
      documentName: record.document_name ?? null,
      documentDisplayName: record.document_display_name ?? null,
      pageNumber: record.source_page_start ?? null,
      pageEnd: record.source_page_end ?? record.source_page_start ?? null,
      sourceSection: record.source_section ?? null,
      sourceLineStart: record.source_line_start ?? null,
      sourceLineEnd: record.source_line_end ?? null,
      language: record.language ?? 'und',
      usageDirection: String(record.usage_direction ?? job.knowledge_base_usage ?? 'both').toLowerCase(),
      label: record.entity_name ?? record.question ?? null,
      summary: String(record.answer ?? record.content ?? '').replace(/\s+/gu, ' ').trim().slice(0, 700) || null,
      category: record.entity_category ?? null,
      metadata: record.entity_metadata && typeof record.entity_metadata === 'object'
        ? record.entity_metadata : {},
      aliases: record.publicationAliases ?? [],
      sttForms: record.publicationSttForms ?? [],
      phoneticForms: record.publicationPhoneticForms ?? [],
      answerCard: record.approvedAnswerCard ?? null,
    })),
  };
}

export async function cacheCompactKnowledgeMap(job, records, cache = redis, publicationBundle = null) {
  const map = buildCompactKnowledgeMap(job, records);
  const sparseIndex = buildRevisionSparseIndex(job, records);
  const evidence = {
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    tenantId: requireTenantId(job.tenant_id),
    knowledgeBaseId: requireEntityId(job.knowledge_base_id, 'knowledgeBaseId'),
    publicationRevision: job.targetRevision,
    records: map.records,
  };
  const keys = {
    map: knowledgeMapCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    sparse: sparseIndexCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    evidence: evidenceCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    entity: entityIndexCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    route: routeIndexCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    answers: answerCardsCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    manifest: publicationManifestCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
  };
  if (!cache || (cache.status && cache.status !== 'ready')) {
    throw new Error('Redis is not ready to cache publication artifacts');
  }
  const identity = {
    version: KNOWLEDGE_PUBLICATION_BUNDLE_VERSION,
    tenantId: requireTenantId(job.tenant_id),
    knowledgeBaseId: requireEntityId(job.knowledge_base_id, 'knowledgeBaseId'),
    publicationRevision: job.targetRevision,
  };
  const entries = [
    [keys.map, map], [keys.sparse, sparseIndex], [keys.evidence, evidence],
    [keys.entity, { ...identity, ...(publicationBundle?.entityIndex ?? { exact: {}, stt: {}, phonetic: {} }) }],
    [keys.route, { ...identity, ...(publicationBundle?.routeIndex ?? { exact: {}, stt: {}, phonetic: {} }) }],
    [keys.answers, { ...identity, records: publicationBundle?.answerCards ?? [] }],
    [keys.manifest, publicationBundle?.manifest ?? { ...identity, recordCount: records.length }],
  ];
  const generationKey = tenantKnowledgeGenerationCacheKey(job.tenant_id);
  const generation = `${requireEntityId(job.knowledge_base_id, 'knowledgeBaseId')}:${job.targetRevision}`;
  try {
    if (typeof cache.multi === 'function') {
      const transaction = cache.multi();
      // These artifacts are immutable and revision-scoped. Expiring them
      // silently disables BM25 for a still-active publication. Older revision
      // keys are explicitly deleted by the publication cleanup path instead.
      for (const [key, value] of entries) transaction.set(key, JSON.stringify(value));
      transaction.set(generationKey, JSON.stringify(generation));
      const results = await transaction.exec();
      if (!Array.isArray(results) || results.some(([error]) => error)) {
        throw new Error('Redis publication artifact transaction failed');
      }
    } else {
      for (const [key, value] of entries) await cache.set(key, JSON.stringify(value));
      await cache.set(generationKey, JSON.stringify(generation));
    }
    if (JSON.parse(await cache.get(generationKey) ?? 'null') !== generation) {
      throw new Error('Redis tenant knowledge generation verification failed');
    }
    for (const [key] of entries) {
      const stored = await cache.get(key);
      const parsed = stored ? JSON.parse(stored) : null;
      if (parsed?.tenantId !== requireTenantId(job.tenant_id)
        || parsed?.knowledgeBaseId !== requireEntityId(job.knowledge_base_id, 'knowledgeBaseId')
        || parsed?.publicationRevision !== job.targetRevision) {
        throw new Error(`Redis publication artifact verification failed for ${key}`);
      }
    }
  } catch (error) {
    await cache.del(...Object.values(keys)).catch(() => undefined);
    throw error;
  }
  return {
    key: keys.map, keys, map, sparseIndex, evidence,
    entityIndex: publicationBundle?.entityIndex ?? null,
    routeIndex: publicationBundle?.routeIndex ?? null,
    answerCards: publicationBundle?.answerCards ?? [],
    manifest: publicationBundle?.manifest ?? null,
    verified: true,
  };
}

export async function deleteRevisionKnowledgeArtifacts(job, cache = redis) {
  if (!cache || (cache.status && cache.status !== 'ready')) return { deleted: 0, verified: false };
  const keys = [
    knowledgeMapCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    sparseIndexCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    evidenceCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    entityIndexCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    routeIndexCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    answerCardsCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
    publicationManifestCacheKey(job.tenant_id, job.knowledge_base_id, job.targetRevision),
  ];
  const deleted = await cache.del(...keys);
  const remaining = (await Promise.all(keys.map((key) => cache.exists(key)))).reduce((sum, value) => sum + value, 0);
  return { deleted, remaining, verified: remaining === 0, keys };
}
