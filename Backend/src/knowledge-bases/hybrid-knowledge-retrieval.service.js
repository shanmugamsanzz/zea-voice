import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redis } from '../infrastructure/redis.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { embedQuery } from '../rag/embedding.client.js';
import {
  QDRANT_SEARCH_LIMIT_MAX, searchTenantPoints,
} from '../rag/qdrant.client.js';
import { requireTenantId } from '../rag/tenant-isolation.js';
import { sparseIndexCacheKey } from './knowledge-map.service.js';
import { latestTurnWorkflowActivation } from './workflow-activation-policy.js';
import { classifyCatalogEntityLocally } from './catalog-entity-resolver.js';

const recordTypes = Object.freeze([
  'CATALOG_ITEM', 'WORKFLOW_RULE', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK',
]);

const defaultDependencies = Object.freeze({
  contextRunner: withTenantContext,
  cache: redis,
  embed: embedQuery,
  search: searchTenantPoints,
  ragEnabled: env.RAG_ENABLED,
});

const activeScopeSql = `
  WITH runtime_agent AS (
    SELECT id, usage_direction
      FROM voice_agents
     WHERE tenant_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL
  ), assigned AS (
    SELECT kb.id, kb.publication_revision, akb.priority
      FROM runtime_agent a
      JOIN agent_knowledge_bases akb
        ON akb.tenant_id=$1 AND akb.agent_id=a.id
      JOIN knowledge_bases kb
        ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
     WHERE kb.status='published' AND kb.deleted_at IS NULL AND kb.publication_revision>0
       AND (a.usage_direction='both' OR a.usage_direction=$3::agent_usage_direction)
       AND (akb.usage_direction='both' OR akb.usage_direction=$3::agent_usage_direction)
       AND (kb.usage_direction='both' OR kb.usage_direction=$3::agent_usage_direction)
       AND EXISTS (
         SELECT 1 FROM knowledge_processing_jobs j
          WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
            AND j.job_type='index' AND j.status='completed'
            AND j.metadata->>'publicationRevision'=kb.publication_revision::text
       )
  )
  SELECT
    (SELECT usage_direction FROM runtime_agent) AS agent_usage,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'publicationRevision', publication_revision, 'priority', priority
    ) ORDER BY priority, id) FROM assigned), '[]'::jsonb) AS knowledge_bases`;

// A bounded identity projection supports noisy-STT entity discovery when the
// intended Catalog record does not enter Qdrant's semantic top set. Exact
// facts are never taken from this projection; selected IDs still pass through
// the authoritative hydration query below.
const catalogIdentitySql = `
  WITH requested_scope AS (
    SELECT knowledge_base_id::uuid, publication_revision::int
      FROM jsonb_to_recordset($4::jsonb)
        AS scope(knowledge_base_id text, publication_revision int)
  ), runtime_agent AS (
    SELECT id, usage_direction FROM voice_agents
     WHERE tenant_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL
  ), assigned AS (
    SELECT kb.id, kb.publication_revision
      FROM runtime_agent a
      JOIN agent_knowledge_bases akb ON akb.tenant_id=$1 AND akb.agent_id=a.id
      JOIN knowledge_bases kb ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
      JOIN requested_scope rs
        ON rs.knowledge_base_id=kb.id AND rs.publication_revision=kb.publication_revision
     WHERE kb.status='published' AND kb.deleted_at IS NULL AND kb.publication_revision>0
       AND (a.usage_direction='both' OR a.usage_direction=$3::agent_usage_direction)
       AND (akb.usage_direction='both' OR akb.usage_direction=$3::agent_usage_direction)
       AND (kb.usage_direction='both' OR kb.usage_direction=$3::agent_usage_direction)
  )
  SELECT i.id, i.item_key, i.name, i.aliases,
    COALESCE(i.category,sc.name) AS category, i.category_key, i.category_aliases,
    i.parent_category_key, i.category_description, i.category_selection_rules,
    i.description, i.relationships, i.knowledge_base_id, i.document_id,
    i.document_version_id, a.publication_revision
    FROM structured_items i
    JOIN assigned a ON a.id=i.knowledge_base_id
    JOIN structured_catalogs sc
      ON sc.tenant_id=i.tenant_id AND sc.knowledge_base_id=i.knowledge_base_id
     AND sc.document_id=i.document_id AND sc.document_version_id=i.document_version_id
     AND sc.id=i.catalog_id AND sc.status='approved'
    JOIN knowledge_document_versions v
      ON v.tenant_id=i.tenant_id AND v.knowledge_base_id=i.knowledge_base_id
     AND v.document_id=i.document_id AND v.id=i.document_version_id
    JOIN knowledge_documents d
      ON d.tenant_id=i.tenant_id AND d.knowledge_base_id=i.knowledge_base_id
     AND d.id=i.document_id
   WHERE i.tenant_id=$1 AND i.status='approved'
     AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
     AND d.status='ready' AND d.deleted_at IS NULL
   ORDER BY i.knowledge_base_id,i.display_order,i.id
   LIMIT 2000`;

// IDs selected by Qdrant/BM25 are never trusted as evidence. This query
// rechecks tenant, agent assignment, active revision, current document version
// and approval status before returning exact authoritative PostgreSQL rows.
const hydrateEvidenceSql = `
  WITH requested AS (
    SELECT upper(record_type) AS record_type, record_id::uuid, knowledge_base_id::uuid,
      rank::int, score::double precision
      FROM jsonb_to_recordset($4::jsonb)
        AS candidate(record_type text, record_id text, knowledge_base_id text, rank int, score double precision)
  ), runtime_agent AS (
    SELECT id, usage_direction FROM voice_agents
     WHERE tenant_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL
  ), assigned AS (
    SELECT kb.id, kb.publication_revision
      FROM runtime_agent a
      JOIN agent_knowledge_bases akb ON akb.tenant_id=$1 AND akb.agent_id=a.id
      JOIN knowledge_bases kb ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
     WHERE kb.status='published' AND kb.deleted_at IS NULL AND kb.publication_revision>0
       AND (a.usage_direction='both' OR a.usage_direction=$3::agent_usage_direction)
       AND (akb.usage_direction='both' OR akb.usage_direction=$3::agent_usage_direction)
       AND (kb.usage_direction='both' OR kb.usage_direction=$3::agent_usage_direction)
       AND EXISTS (
         SELECT 1 FROM knowledge_processing_jobs j
          WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
            AND j.job_type='index' AND j.status='completed'
            AND j.metadata->>'publicationRevision'=kb.publication_revision::text
       )
  ), evidence AS (
    SELECT 'FAQ'::text AS record_type, f.id AS record_id, f.knowledge_base_id,
      f.tenant_id, $2::uuid AS agent_id, a.publication_revision,
      f.document_id, f.document_version_id, d.original_filename AS document_name,
      f.source_page_start, f.source_page_end, COALESCE(NULLIF(f.language,''), 'und') AS language,
      f.answer AS content, true AS caller_facing,
      jsonb_build_object(
        'question',f.question,'answer',f.answer,'language',f.language,
        'usageDirection',f.usage_direction
      ) AS authoritative_data,
      r.rank, r.score
      FROM requested r JOIN faq_entries f ON r.record_type='FAQ' AND f.id=r.record_id
      JOIN assigned a ON a.id=f.knowledge_base_id AND a.id=r.knowledge_base_id
      JOIN knowledge_document_versions v
        ON v.tenant_id=f.tenant_id AND v.knowledge_base_id=f.knowledge_base_id
       AND v.document_id=f.document_id AND v.id=f.document_version_id
      JOIN knowledge_documents d
        ON d.tenant_id=f.tenant_id AND d.knowledge_base_id=f.knowledge_base_id
       AND d.id=f.document_id
     WHERE f.tenant_id=$1 AND f.status='approved'
       AND (f.usage_direction='both' OR f.usage_direction=$3::agent_usage_direction)
       AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       AND d.status='ready' AND d.deleted_at IS NULL
    UNION ALL
    SELECT 'KNOWLEDGE_CHUNK', c.id, c.knowledge_base_id,
      c.tenant_id, $2::uuid, a.publication_revision,
      c.document_id, c.document_version_id,
      d.original_filename, c.source_page_start, c.source_page_end,
      COALESCE(NULLIF(d.metadata->>'language',''), 'und'), c.content, true,
      jsonb_build_object(
        'heading',c.source_heading,'content',c.content,'chunkIndex',c.chunk_index,
        'tokenCount',c.token_count,'usageDirection',c.usage_direction
      ), r.rank, r.score
      FROM requested r JOIN knowledge_chunks c ON r.record_type='KNOWLEDGE_CHUNK' AND c.id=r.record_id
      JOIN assigned a ON a.id=c.knowledge_base_id AND a.id=r.knowledge_base_id
      JOIN knowledge_document_versions v
        ON v.tenant_id=c.tenant_id AND v.knowledge_base_id=c.knowledge_base_id
       AND v.document_id=c.document_id AND v.id=c.document_version_id
      JOIN knowledge_documents d
        ON d.tenant_id=c.tenant_id AND d.knowledge_base_id=c.knowledge_base_id
       AND d.id=c.document_id
     WHERE c.tenant_id=$1 AND c.status='approved'
       AND (c.usage_direction='both' OR c.usage_direction=$3::agent_usage_direction)
       AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       AND d.status='ready' AND d.deleted_at IS NULL
    UNION ALL
    SELECT 'CATALOG_ITEM', i.id, i.knowledge_base_id,
      i.tenant_id, $2::uuid, a.publication_revision,
      i.document_id, i.document_version_id,
      d.original_filename, i.source_page_start, i.source_page_end,
      COALESCE(NULLIF(d.metadata->>'language',''), 'und'),
      concat_ws(E'\n','Item: '||i.name,'Category: '||COALESCE(i.category,sc.name),
        CASE WHEN i.description IS NOT NULL THEN 'Description: '||i.description END,
        CASE WHEN i.price IS NOT NULL THEN 'Price: '||i.price::text||' '||COALESCE(i.currency,'') END,
        CASE WHEN attrs.values_json <> '[]'::jsonb THEN 'Details: '||attrs.values_json::text END),
      true,
      jsonb_build_object(
        'catalogId',sc.id,'catalogType',sc.catalog_type,'catalogName',sc.name,
        'catalogDescription',sc.description,'catalogDefaultCurrency',sc.default_currency,
        'itemKey',i.item_key,'name',i.name,'aliases',i.aliases,
        'category',COALESCE(i.category,sc.name),'categoryAliases',i.category_aliases,
        'categoryKey',i.category_key,'parentCategoryKey',i.parent_category_key,
        'categoryDescription',i.category_description,
        'categorySelectionRules',i.category_selection_rules,
        'description',i.description,'price',i.price,'currency',i.currency,
        'displayOrder',i.display_order,'attributes',attrs.values_json,
        'relationships',i.relationships,'selectionRules',i.selection_rules
      ),
      r.rank, r.score
      FROM requested r JOIN structured_items i ON r.record_type='CATALOG_ITEM' AND i.id=r.record_id
      JOIN assigned a ON a.id=i.knowledge_base_id AND a.id=r.knowledge_base_id
      JOIN structured_catalogs sc
        ON sc.tenant_id=i.tenant_id AND sc.knowledge_base_id=i.knowledge_base_id
       AND sc.document_id=i.document_id AND sc.document_version_id=i.document_version_id
       AND sc.id=i.catalog_id AND sc.status='approved'
      JOIN knowledge_document_versions v
        ON v.tenant_id=i.tenant_id AND v.knowledge_base_id=i.knowledge_base_id
       AND v.document_id=i.document_id AND v.id=i.document_version_id
      JOIN knowledge_documents d
        ON d.tenant_id=i.tenant_id AND d.knowledge_base_id=i.knowledge_base_id
       AND d.id=i.document_id
      LEFT JOIN LATERAL (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'key',x.attribute_key,'name',x.display_name,'value',x.value,
        'displayOrder',x.display_order
      ) ORDER BY x.display_order,x.id),'[]'::jsonb) AS values_json
        FROM structured_item_attributes x
       WHERE x.tenant_id=i.tenant_id
         AND x.knowledge_base_id=i.knowledge_base_id
         AND x.document_id=i.document_id
         AND x.document_version_id=i.document_version_id
         AND x.item_id=i.id) attrs ON true
     WHERE i.tenant_id=$1 AND i.status='approved'
       AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       AND d.status='ready' AND d.deleted_at IS NULL
    UNION ALL
    SELECT 'WORKFLOW_RULE', w.id, w.knowledge_base_id,
      w.tenant_id, $2::uuid, a.publication_revision,
      w.document_id, w.document_version_id,
      d.original_filename, w.source_page_start, w.source_page_end,
      COALESCE(NULLIF(d.metadata->>'language',''), 'und'), COALESCE(w.response_template,''),
      lower(COALESCE(w.action_config->>'responseMode','instruction'))='exact',
      jsonb_build_object('name',w.name,'intent',w.intent,'priority',w.priority,
        'conditions',w.conditions,'actionType',w.action_type,'actionConfig',w.action_config,
        'responseMode',COALESCE(w.action_config->>'responseMode','instruction'),
        'responseTemplate',w.response_template,'usageDirection',w.usage_direction),
      r.rank, r.score
      FROM requested r JOIN workflow_rules w ON r.record_type='WORKFLOW_RULE' AND w.id=r.record_id
      JOIN assigned a ON a.id=w.knowledge_base_id AND a.id=r.knowledge_base_id
      JOIN knowledge_document_versions v
        ON v.tenant_id=w.tenant_id AND v.knowledge_base_id=w.knowledge_base_id
       AND v.document_id=w.document_id AND v.id=w.document_version_id
      JOIN knowledge_documents d
        ON d.tenant_id=w.tenant_id AND d.knowledge_base_id=w.knowledge_base_id
       AND d.id=w.document_id
     WHERE w.tenant_id=$1 AND w.status='approved'
       AND (w.usage_direction='both' OR w.usage_direction=$3::agent_usage_direction)
       AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       AND d.status='ready' AND d.deleted_at IS NULL
    UNION ALL
    SELECT 'CONVERSATION_NODE', f.id, f.knowledge_base_id,
      f.tenant_id, $2::uuid, a.publication_revision,
      f.document_id, f.document_version_id,
      d.original_filename, f.source_page_start, f.source_page_end,
      COALESCE(NULLIF(f.language,''),NULLIF(d.metadata->>'language',''),'und'), f.content,
      lower(COALESCE(f.node_type,''))<>'guidance',
      jsonb_build_object('flowKey',f.flow_key,'nodeKey',f.node_key,'nodeType',f.node_type,
        'language',f.language,'sequenceOrder',f.sequence_order,'isEntry',f.is_entry,
        'content',f.content,'variables',f.variables,'transitions',f.transitions,
        'usageDirection',f.usage_direction), r.rank, r.score
      FROM requested r JOIN conversation_flows f ON r.record_type='CONVERSATION_NODE' AND f.id=r.record_id
      JOIN assigned a ON a.id=f.knowledge_base_id AND a.id=r.knowledge_base_id
      JOIN knowledge_document_versions v
        ON v.tenant_id=f.tenant_id AND v.knowledge_base_id=f.knowledge_base_id
       AND v.document_id=f.document_id AND v.id=f.document_version_id
      JOIN knowledge_documents d
        ON d.tenant_id=f.tenant_id AND d.knowledge_base_id=f.knowledge_base_id
       AND d.id=f.document_id
     WHERE f.tenant_id=$1 AND f.status='approved'
       AND (f.usage_direction='both' OR f.usage_direction=$3::agent_usage_direction)
       AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
       AND d.status='ready' AND d.deleted_at IS NULL
  ) SELECT * FROM evidence ORDER BY rank, record_type, record_id`;

const catalogCategoryCandidatesSql = `
  WITH runtime_agent AS (
    SELECT id, usage_direction FROM voice_agents
     WHERE tenant_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL
  ), assigned AS (
    SELECT kb.id, kb.publication_revision
      FROM runtime_agent a
      JOIN agent_knowledge_bases akb ON akb.tenant_id=$1 AND akb.agent_id=a.id
      JOIN knowledge_bases kb ON kb.tenant_id=akb.tenant_id AND kb.id=akb.knowledge_base_id
     WHERE kb.status='published' AND kb.deleted_at IS NULL AND kb.publication_revision>0
       AND (a.usage_direction='both' OR a.usage_direction=$3::agent_usage_direction)
       AND (akb.usage_direction='both' OR akb.usage_direction=$3::agent_usage_direction)
       AND (kb.usage_direction='both' OR kb.usage_direction=$3::agent_usage_direction)
       AND EXISTS (
         SELECT 1 FROM knowledge_processing_jobs j
          WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
            AND j.job_type='index' AND j.status='completed'
            AND j.metadata->>'publicationRevision'=kb.publication_revision::text
       )
  )
  SELECT 'CATALOG_ITEM'::text AS record_type, i.id AS record_id,
    i.knowledge_base_id, i.document_id, i.document_version_id,
    COALESCE(NULLIF(d.metadata->>'language',''), 'und') AS language
    FROM structured_items i
    JOIN assigned a ON a.id=i.knowledge_base_id AND a.id=$4::uuid
    JOIN structured_catalogs sc
      ON sc.tenant_id=i.tenant_id AND sc.knowledge_base_id=i.knowledge_base_id
     AND sc.document_id=i.document_id AND sc.document_version_id=i.document_version_id
     AND sc.id=i.catalog_id AND sc.id=$5::uuid AND sc.status='approved'
    JOIN knowledge_document_versions v
      ON v.tenant_id=i.tenant_id AND v.knowledge_base_id=i.knowledge_base_id
     AND v.document_id=i.document_id AND v.id=i.document_version_id
    JOIN knowledge_documents d
      ON d.tenant_id=i.tenant_id AND d.knowledge_base_id=i.knowledge_base_id
     AND d.id=i.document_id
   WHERE i.tenant_id=$1 AND i.status='approved' AND i.category_key=$6
     AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
     AND d.status='ready' AND d.deleted_at IS NULL
   ORDER BY i.display_order, i.id
   LIMIT $7`;

const maximumHydratedCategoryChildren = 100;

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function tokens(value) {
  return normalize(value).split(' ').filter(Boolean);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deadline(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

async function abortable(promise, signal, fallback) {
  if (!signal) return promise;
  if (signal.aborted) return fallback;
  let handler;
  const aborted = new Promise((resolve) => {
    handler = () => resolve(fallback);
    signal.addEventListener('abort', handler, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', handler); }
}

async function readJson(cache, key) {
  if (!cache || (cache.status && cache.status !== 'ready')) return null;
  const raw = await deadline(cache.get(key), env.RAG_RUNTIME_CACHE_TIMEOUT_MS, null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function queryParts(values) {
  return values.map((value) => String(value ?? '').trim()).filter(Boolean).join(' ').slice(0, 2_000);
}

function primaryQuery(input) {
  // The finalized latest utterance is the only primary query for both
  // Qdrant and BM25. No inferred intent or memory text may replace it.
  return queryParts([input.latestCallerUtterance ?? input.query]);
}

function contextualQuery(input, primary) {
  if (!contextIsAvailable(input)) return '';
  // Context is deliberately narrow. Only the currently selected entity and
  // pending question may resolve a weak standalone follow-up; old answers,
  // topics and arbitrary history cannot pull retrieval back to stale content.
  return queryParts([
    primary,
    input.pendingQuestion,
    ...(Array.isArray(input.knownEntities) ? input.knownEntities : [])
      .flatMap((entity) => [entity.name, entity.key, entity.category]),
  ]);
}

export function isolatedRetrievalQueries(input = {}) {
  const primary = primaryQuery(input);
  const contextual = contextualQuery(input, primary);
  return Object.freeze({
    primary,
    contextual: contextual && normalize(contextual) !== normalize(primary) ? contextual : '',
  });
}

function candidateKey(candidate) {
  return `${candidate.recordType}:${String(candidate.recordId).toLowerCase()}:${String(candidate.knowledgeBaseId).toLowerCase()}`;
}

export function rankBm25Documents(indexes, query, scope, input = {}) {
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length) return [];
  const allowed = new Map(scope.map((item) => [String(item.id).toLowerCase(), Number(item.publicationRevision)]));
  const documents = indexes.flatMap((index) => index?.documents ?? []).filter((document) => (
    String(document.tenantId).toLowerCase() === String(input.tenantId).toLowerCase()
    && allowed.get(String(document.knowledgeBaseId).toLowerCase()) === Number(document.publicationRevision)
    && ['both', String(input.usageDirection).toLowerCase()].includes(String(document.usageDirection).toLowerCase())
    && recordTypes.includes(String(document.recordType).toUpperCase())
  ));
  if (!documents.length) return [];
  const documentFrequency = {};
  for (const document of documents) {
    for (const token of new Set(document.tokens ?? [])) documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
  }
  const averageLength = documents.reduce((sum, document) => sum + Math.max(1, document.tokens?.length ?? 0), 0)
    / documents.length;
  return documents.map((document) => {
    const frequencies = new Map();
    for (const token of document.tokens ?? []) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (!frequency) continue;
      matched += 1;
      const df = documentFrequency[token] ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75
        * ((document.tokens?.length ?? 0) / Math.max(1, averageLength)));
      score += idf * ((frequency * 2.2) / denominator);
    }
    return {
      recordType: String(document.recordType).toUpperCase(), recordId: document.id,
      knowledgeBaseId: document.knowledgeBaseId, documentId: document.documentId,
      documentVersionId: document.documentVersionId,
      publicationRevision: Number(document.publicationRevision), language: document.language,
      lexicalScore: score, tokenCoverage: matched / queryTokens.length,
      channel: 'bm25', contentPreview: document.content,
    };
  }).filter((candidate) => candidate.lexicalScore > 0)
    .sort((left, right) => right.tokenCoverage - left.tokenCoverage || right.lexicalScore - left.lexicalScore)
    .slice(0, 20).map((candidate, index) => ({ ...candidate, channelRank: index + 1 }));
}

export function mergeAndRerankCandidates(semantic, lexical, query, language = 'und', limit = 5) {
  const merged = new Map();
  const add = (candidate, channel) => {
    const key = candidateKey(candidate);
    const current = merged.get(key) ?? { ...candidate, semanticScore: 0, lexicalScore: 0, tokenCoverage: 0, channels: [] };
    current.channels = [...new Set([...current.channels, channel])];
    current[`${channel}Rank`] = candidate.channelRank;
    if (channel === 'semantic') current.semanticScore = Math.max(current.semanticScore, Number(candidate.semanticScore ?? 0));
    if (channel === 'bm25') {
      current.lexicalScore = Math.max(current.lexicalScore, Number(candidate.lexicalScore ?? 0));
      current.tokenCoverage = Math.max(current.tokenCoverage, Number(candidate.tokenCoverage ?? 0));
    }
    merged.set(key, current);
  };
  semantic.forEach((candidate) => add(candidate, 'semantic'));
  lexical.forEach((candidate) => add(candidate, 'bm25'));
  const normalizedQuery = normalize(query);
  const ranked = [...merged.values()].map((candidate) => {
    const preview = normalize(candidate.contentPreview);
    const exactBonus = normalizedQuery && preview.includes(normalizedQuery) ? 0.16 : 0;
    const languageBonus = String(candidate.language ?? 'und').toLowerCase() === String(language).toLowerCase() ? 0.02 : 0;
    const reciprocalRank = (candidate.semanticRank ? 1 / (60 + candidate.semanticRank) : 0)
      + (candidate.bm25Rank ? 1 / (60 + candidate.bm25Rank) : 0);
    const score = reciprocalRank + candidate.semanticScore * 0.55
      + Math.min(candidate.lexicalScore, 8) / 8 * 0.2 + candidate.tokenCoverage * 0.15
      + exactBonus + languageBonus + (candidate.channels.length > 1 ? 0.05 : 0);
    return { ...candidate, score };
  }).sort((left, right) => right.score - left.score
    || candidateKey(left).localeCompare(candidateKey(right)));
  const maximum = Math.max(3, Math.min(Number(limit) || 5, 8));
  // Preserve the strongest structured item and caller-guidance discovery
  // candidates alongside the globally strongest matches. Without this
  // diversity, several near-identical FAQ vectors can crowd authoritative
  // Catalog or Conversation records out before PostgreSQL hydration.
  const selected = [];
  const selectedKeys = new Set();
  const addSelected = (candidate) => {
    const key = candidate && candidateKey(candidate);
    if (!candidate || selectedKeys.has(key) || selected.length >= maximum) return;
    selectedKeys.add(key);
    selected.push(candidate);
  };
  ranked.slice(0, Math.max(1, maximum - 2)).forEach(addSelected);
  addSelected(ranked.find((candidate) => candidate.recordType === 'CONVERSATION_NODE'));
  addSelected(ranked.find((candidate) => candidate.recordType === 'CATALOG_ITEM'));
  ranked.forEach(addSelected);
  return selected
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function candidateStrength(candidate, query) {
  const semantic = Math.max(0, Number(candidate?.semanticScore ?? 0));
  const coverage = Math.max(0, Number(candidate?.tokenCoverage ?? 0));
  const lexical = Math.max(0, Number(candidate?.lexicalScore ?? 0));
  const channels = new Set(candidate?.channels ?? []);
  const normalizedQuery = normalize(query);
  const exactCoverage = normalizedQuery.length >= 2
    && normalize(candidate?.contentPreview).includes(normalizedQuery);
  const semanticStrong = semantic >= env.RAG_RUNTIME_MIN_SCORE;
  const lexicalStrong = coverage >= 0.5 && lexical > 0;
  // Structured Catalog rows and published Conversation messages often use a
  // concise canonical name while callers use a longer natural-language
  // request. A high BM25 score with meaningful coverage is sufficient for
  // discovery even when the semantic channel is unavailable. PostgreSQL
  // hydration still performs the authoritative tenant/agent/revision check.
  const recordType = String(candidate?.recordType ?? '').toUpperCase();
  const catalogLexicalStrong = recordType === 'CATALOG_ITEM'
    && coverage >= 0.35 && lexical >= 3;
  const messageLexicalStrong = recordType === 'CONVERSATION_NODE'
    && coverage >= 0.4 && lexical >= 4;
  const corroborated = channels.has('semantic') && channels.has('bm25')
    && semantic >= Math.max(0, env.RAG_RUNTIME_MIN_SCORE - 0.08)
    && coverage >= 0.2;
  return Object.freeze({
    accepted: exactCoverage || semanticStrong || lexicalStrong
      || catalogLexicalStrong || messageLexicalStrong || corroborated,
    exactCoverage, semanticStrong, lexicalStrong, catalogLexicalStrong,
    messageLexicalStrong, corroborated,
  });
}

export function retainStrongCandidates(candidates = [], query = '', maximum = 5) {
  const limit = Math.max(3, Math.min(Number(maximum) || 5, 8));
  return candidates.map((candidate) => ({
    candidate,
    strength: candidateStrength(candidate, query),
  })).filter((entry) => entry.strength.accepted)
    .slice(0, limit)
    .map(({ candidate, strength }, index) => ({
      ...candidate, rank: index + 1, strength,
    }));
}

function primaryEvidenceIsSufficient(candidates, query) {
  const first = candidates[0];
  if (!first) return false;
  const normalizedQuery = normalize(query);
  const exactCoverage = normalizedQuery.length >= 3
    && normalize(first.contentPreview).includes(normalizedQuery);
  const lexicalCoverage = Number(first.tokenCoverage ?? 0) >= 0.6;
  const semanticScore = Number(first.semanticScore ?? 0);
  const runnerUpScore = Number(candidates[1]?.semanticScore ?? 0);
  const semanticFloor = Math.min(0.98, Math.max(0.82, env.RAG_RUNTIME_MIN_SCORE + 0.08));
  const multiChannel = Array.isArray(first.channels) && first.channels.length > 1
    && semanticScore >= env.RAG_RUNTIME_MIN_SCORE;
  return exactCoverage || lexicalCoverage || multiChannel
    || (semanticScore >= semanticFloor && semanticScore - runnerUpScore >= 0.04);
}

function contextIsAvailable(input) {
  return Boolean(String(input.pendingQuestion ?? '').trim())
    || (Array.isArray(input.knownEntities) && input.knownEntities.length > 0);
}

export function contextualRetrievalPolicy(input, query, primaryCandidates = []) {
  const available = contextIsAvailable(input);
  const queryTokens = tokens(query);
  const compactTurn = queryTokens.length > 0 && queryTokens.length <= 4
    && Array.from(String(query ?? '')).length <= 80;
  const explicitlyContextual = input.contextualFollowUp === true;
  const primarySufficient = primaryEvidenceIsSufficient(primaryCandidates, query);
  const primaryRecordType = String(primaryCandidates[0]?.recordType ?? '').toUpperCase();
  return Object.freeze({
    available,
    compactTurn,
    explicitlyContextual,
    primarySufficient,
    // A compact response or reference is normally meaningful only together
    // with the immediately pending question or selected entity. Longer turns
    // retain latest-utterance-first behavior unless their evidence is weak.
    // Context is an explicit/compact-turn resolver only. Do not pay for a
    // second vector search on a normal multi-word request whose latest query
    // already produced a usable primary candidate.
    useContext: available && (explicitlyContextual
      || (compactTurn
        && primaryRecordType !== 'CATALOG_ITEM'
        && (!primarySufficient || primaryRecordType !== 'CONVERSATION_NODE'))),
    // Do not let a generic message match consume a compact continuation. An
    // explicit item match remains primary even when the utterance is short.
    preferContext: available && (explicitlyContextual
      || (compactTurn && primaryRecordType !== 'CATALOG_ITEM')),
  });
}

export function prioritizeCandidates(primary, contextual, useContext, preferContext, limit) {
  const unique = new Map();
  // The finalized latest utterance is always the primary query. Context is
  // only a resolver for genuine follow-ups and must never displace an
  // explicit new request or an evidence candidate found for that request.
  const primaryCandidates = primary.map((candidate) => ({ ...candidate, retrievalContext: 'primary' }));
  const contextualCandidates = useContext
    ? contextual.map((candidate) => ({ ...candidate, retrievalContext: 'contextual' })) : [];
  const candidates = preferContext
    ? [...contextualCandidates, ...primaryCandidates]
    : [...primaryCandidates, ...contextualCandidates];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const maximum = Math.max(3, Math.min(Number(limit) || 5, 5));
  const ordered = [...unique.values()];
  const selected = [];
  const selectedKeys = new Set();
  const add = (candidate) => {
    if (!candidate || selected.length >= maximum) return;
    const key = candidateKey(candidate);
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(candidate);
  };
  // Preserve globally strong results while reserving room for authoritative
  // structured and conversational evidence. A contextual turn can require
  // the LLM to distinguish two semantically close published messages using
  // the pending question, so retaining only one message would decide too
  // early and make the correct response impossible to select.
  const catalogCandidate = ordered.find((candidate) => candidate.recordType === 'CATALOG_ITEM');
  // On a contextual turn, several semantically close published messages can
  // be valid retrieval candidates. Preserve every message that fits inside
  // the final evidence budget and let the grounded decision resolve them from
  // the pending question. A fixed two-message cap can discard the correct
  // response before the decision sees it.
  const conversationLimit = useContext
    ? Math.max(1, maximum - (catalogCandidate ? 1 : 0))
    : 1;
  const conversationCandidates = ordered
    .filter((candidate) => candidate.recordType === 'CONVERSATION_NODE')
    .slice(0, conversationLimit);
  const reservedCount = conversationCandidates.length + (catalogCandidate ? 1 : 0);
  ordered.slice(0, Math.max(1, maximum - reservedCount)).forEach(add);
  conversationCandidates.forEach(add);
  add(catalogCandidate);
  ordered.forEach(add);
  return selected.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function mergeCandidateSignals(preferred, additional) {
  if (!preferred) return additional;
  if (!additional) return preferred;
  return {
    ...additional,
    ...preferred,
    score: Math.max(Number(preferred.score ?? 0), Number(additional.score ?? 0)),
    semanticScore: Math.max(
      Number(preferred.semanticScore ?? 0), Number(additional.semanticScore ?? 0),
    ),
    lexicalScore: Math.max(
      Number(preferred.lexicalScore ?? 0), Number(additional.lexicalScore ?? 0),
    ),
    tokenCoverage: Math.max(
      Number(preferred.tokenCoverage ?? 0), Number(additional.tokenCoverage ?? 0),
    ),
    semanticRank: preferred.semanticRank ?? additional.semanticRank ?? null,
    bm25Rank: preferred.bm25Rank ?? additional.bm25Rank ?? null,
    channels: [...new Set([...(preferred.channels ?? []), ...(additional.channels ?? [])])],
  };
}

function traceCandidate(candidate, rejectionReasons = []) {
  return Object.freeze({
    recordId: candidate.recordId ?? candidate.id ?? null,
    recordType: candidate.recordType ?? null,
    knowledgeBaseId: candidate.knowledgeBaseId ?? null,
    documentId: candidate.documentId ?? null,
    documentVersionId: candidate.documentVersionId ?? null,
    publicationRevision: Number(candidate.publicationRevision ?? 0) || null,
    score: Number(candidate.score ?? 0),
    semanticScore: Number(candidate.semanticScore ?? 0),
    lexicalScore: Number(candidate.lexicalScore ?? 0),
    tokenCoverage: Number(candidate.tokenCoverage ?? 0),
    channels: Object.freeze([...(candidate.channels ?? [])]),
    retrievalContext: candidate.retrievalContext ?? null,
    rejectionReasons: Object.freeze([...rejectionReasons]),
  });
}

function weakCandidateReasons(candidate, query) {
  const strength = candidateStrength(candidate, query);
  if (strength.accepted) return [];
  const reasons = [];
  if (!strength.exactCoverage) reasons.push('no_exact_coverage');
  if (!strength.semanticStrong) reasons.push('semantic_below_threshold');
  if (!strength.lexicalStrong) reasons.push('lexical_below_threshold');
  if (!strength.corroborated) reasons.push('not_cross_channel_corroborated');
  return reasons;
}

function catalogValue(value) {
  return normalize(value).replace(/\s+/gu, ' ').trim();
}

export function focusAuthoritativeCatalogEvidence(evidence = [], input = {}, maximum = 5) {
  const limit = Math.max(3, Math.min(Number(maximum) || 5, 5));
  const catalogIdentityResolved = input.catalogIdentityResolved === true;
  const preferredCallerMessage = !catalogIdentityResolved
    && input.preferredCallerMessage?.recordType === 'CONVERSATION_NODE'
    && input.preferredCallerMessage?.callerFacing === true
    ? input.preferredCallerMessage : null;
  const catalog = evidence.filter((item) => item.recordType === 'CATALOG_ITEM');
  if (!catalog.length) {
    const ordered = preferredCallerMessage
      ? [preferredCallerMessage, ...evidence.filter((item) => item.id !== preferredCallerMessage.id)]
      : evidence;
    return Object.freeze({ focused: false, evidence: Object.freeze(ordered.slice(0, limit)) });
  }

  const selected = (input.knownEntities ?? []).flatMap((entity) => [
    entity?.key, entity?.name, entity?.category, entity?.categoryKey,
  ]).map(catalogValue).filter(Boolean);
  const selectedSet = new Set(selected);
  const exactSelected = catalog.filter((item) => {
    const data = item.authoritativeData ?? {};
    return [data.itemKey, data.name].map(catalogValue).some((value) => selectedSet.has(value));
  });
  const categorySelected = catalog.filter((item) => {
    const data = item.authoritativeData ?? {};
    return [data.categoryKey, data.category].map(catalogValue).some((value) => selectedSet.has(value));
  });
  const firstEvidence = evidence[0];
  // A Catalog candidate is entity-defining only when it is the strongest
  // latest-turn evidence or matches an entity already selected in memory.
  // Merely appearing later in a semantic result set must not erase stronger
  // Conversation/FAQ evidence for an unrelated acknowledgement or question.
  const topPrimaryCatalog = firstEvidence?.recordType === 'CATALOG_ITEM'
    && firstEvidence?.retrievalContext === 'primary' ? firstEvidence : null;
  const topCatalog = topPrimaryCatalog
    ?? (firstEvidence?.recordType === 'CATALOG_ITEM' ? firstEvidence : null);
  if (!exactSelected.length && !categorySelected.length && !topCatalog) {
    const ordered = preferredCallerMessage
      ? [preferredCallerMessage, ...evidence.filter((item) => item.id !== preferredCallerMessage.id)]
      : evidence;
    return Object.freeze({ focused: false, evidence: Object.freeze(ordered.slice(0, limit)) });
  }

  let resolvedCatalog;
  if (topPrimaryCatalog) {
    const data = topPrimaryCatalog.authoritativeData ?? {};
    const queryTokens = new Set(tokens(input.latestCallerUtterance ?? input.query));
    const overlap = (values) => new Set(values.flatMap((value) => tokens(value)))
      .size ? [...new Set(values.flatMap((value) => tokens(value)))]
        .filter((token) => queryTokens.has(token)).length : 0;
    const itemAffinity = overlap([data.itemKey, data.name, ...(data.aliases ?? [])]);
    const categoryAffinity = overlap([
      data.categoryKey, data.category, ...(data.categoryAliases ?? []),
    ]);
    if (categoryAffinity > itemAffinity) {
      const primaryCategory = catalogValue(data.categoryKey ?? data.category);
      resolvedCatalog = catalog.filter((item) => {
        const itemData = item.authoritativeData ?? {};
        return [itemData.categoryKey, itemData.category].map(catalogValue).includes(primaryCategory);
      });
    } else {
      // The latest utterance produced a primary item candidate. It must not
      // be replaced by a remembered entity from a previous turn.
      resolvedCatalog = [topPrimaryCatalog];
    }
  } else if (exactSelected.length) resolvedCatalog = exactSelected;
  else if (categorySelected.length) resolvedCatalog = categorySelected;
  else {
    const topCategory = catalogValue(topCatalog.authoritativeData?.categoryKey
      ?? topCatalog.authoritativeData?.category);
    resolvedCatalog = catalog.filter((item) => {
      const data = item.authoritativeData ?? {};
      return !topCategory || [data.categoryKey, data.category]
        .map(catalogValue).includes(topCategory);
    });
  }

  const supportingRules = evidence.filter((item) => (
    (item.recordType === 'WORKFLOW_RULE' || item.recordType === 'CONVERSATION_NODE')
    && item.callerFacing !== true
  ));
  // A multi-fact request may legitimately need a Catalog row plus another
  // caller-facing record (for example an item attribute and a stable policy).
  // Catalog focus establishes the primary entity but must not erase those
  // already-ranked complementary facts.
  const preserveComplementaryFacts = Array.isArray(input.requestedFacts)
    && new Set(input.requestedFacts.map(catalogValue).filter(Boolean)).size > 1;
  const complementaryCallerEvidence = preserveComplementaryFacts
    ? evidence.filter((item) => item.callerFacing === true
      && item.recordType !== 'CATALOG_ITEM'
      && item.id !== preferredCallerMessage?.id)
    : [];
  const unique = new Map();
  for (const item of [
    preferredCallerMessage,
    ...resolvedCatalog,
    ...complementaryCallerEvidence,
    ...supportingRules,
  ]) {
    if (!item) continue;
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return Object.freeze({
    focused: true,
    evidence: Object.freeze([...unique.values()].slice(0, limit)
      .map((item, index) => ({ ...item, rank: index + 1 }))),
  });
}

function evidenceIdentityForConflict(evidence) {
  const data = evidence?.authoritativeData ?? {};
  const key = data.itemKey ?? data.nodeKey ?? data.name ?? data.question ?? data.heading;
  return key ? `${String(evidence.recordType).toUpperCase()}:${normalize(key)}` : null;
}

const nonComparableFactKeys = new Set([
  'itemkey', 'nodekey', 'categorykey', 'name', 'heading', 'question',
  'description', 'answer', 'content', 'responsetemplate', 'relationships',
  'selectionrules', 'aliases', 'examples', 'variables',
]);

function comparableScalarFacts(value, path = [], output = new Map()) {
  if (value === null || value === undefined || value === '') return output;
  if (Array.isArray(value)) return output;
  if (typeof value !== 'object') {
    if (path.length) output.set(path.join('.'), normalize(value));
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (nonComparableFactKeys.has(normalize(key).replace(/\s+/gu, ''))) continue;
    comparableScalarFacts(entry, [...path, normalize(key)], output);
  }
  return output;
}

function contradictoryFactPaths(left, right) {
  const leftFacts = comparableScalarFacts(left?.authoritativeData ?? {});
  const rightFacts = comparableScalarFacts(right?.authoritativeData ?? {});
  return [...leftFacts.entries()].flatMap(([path, value]) => (
    rightFacts.has(path) && rightFacts.get(path) !== value ? [path] : []
  ));
}

export function detectEvidenceConflict(evidence = [], margin = 0.06) {
  const candidates = evidence.filter((item) => item.retrievalContext === 'primary')
    .sort((left, right) => Number(right.retrievalScore ?? right.score ?? 0)
      - Number(left.retrievalScore ?? left.score ?? 0));
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const scoreGap = Math.abs(Number(left.retrievalScore ?? left.score ?? 0)
        - Number(right.retrievalScore ?? right.score ?? 0));
      if (scoreGap >= margin) continue;
      const leftIdentity = evidenceIdentityForConflict(left);
      const rightIdentity = evidenceIdentityForConflict(right);
      if (!leftIdentity || leftIdentity !== rightIdentity) continue;
      const factPaths = contradictoryFactPaths(left, right);
      if (!factPaths.length) continue;
      return Object.freeze({
        detected: true, type: 'conflicting_facts',
        recordIds: Object.freeze([left.recordId, right.recordId]),
        factPaths: Object.freeze(factPaths), scoreGap,
      });
    }
  }
  return Object.freeze({ detected: false, type: null, recordIds: [] });
}

export function resolveConfidenceResponseRoute({
  directMessage = null, evidence = [], conflict = null, rejectedCandidates = 0,
} = {}) {
  const relevant = evidence.filter((item) => item?.content || item?.authoritativeData);
  const top = relevant[0];
  const confidence = Math.max(0, Number(top?.semanticScore
    ?? top?.retrievalScore ?? top?.score ?? 0));
  if (conflict?.detected === true) return Object.freeze({
    outcome: 'clarify', reason: conflict.type ?? 'conflicting_evidence',
    confidence, evidenceCount: relevant.length,
  });
  if (directMessage) return Object.freeze({
    outcome: 'direct', reason: 'strong_unambiguous_caller_response',
    confidence: Math.max(confidence, Number(directMessage.semanticScore ?? 0)),
    evidenceCount: relevant.length,
  });
  if (relevant.length > 0) return Object.freeze({
    outcome: 'grounded_llm', reason: 'reasoning_required',
    confidence, evidenceCount: relevant.length,
  });
  return Object.freeze({
    outcome: 'clarify', reason: rejectedCandidates > 0 ? 'weak_evidence' : 'evidence_unavailable',
    confidence: 0, evidenceCount: 0,
  });
}

export function messageSelectionScore(evidence, query, input = {}) {
  if (evidence?.recordType !== 'CONVERSATION_NODE' || evidence?.callerFacing !== true
    || String(evidence.authoritativeData?.nodeType ?? '').toLowerCase() !== 'message') return 0;
  // This score is diagnostic only. Candidate order remains the hybrid
  // semantic/BM25 order; a message never receives automatic priority merely
  // because it is caller-facing.
  const semantic = Math.max(0, Number(evidence.semanticScore ?? 0));
  const lexical = Math.max(0, Number(evidence.tokenCoverage ?? 0));
  const retrieval = Math.max(0, Number(evidence.retrievalScore ?? evidence.score ?? 0));
  const multiChannel = Array.isArray(evidence.channels) && evidence.channels.length > 1 ? 0.05 : 0;
  const configuredContext = normalize(conversationVariable(evidence, 'context') ?? 'any')
    .replace(/\s+/gu, '_');
  const contextFit = configuredContext === 'any' ? 0 : 0.05;
  const retrievalContext = evidence.retrievalContext ?? 'primary';
  const contextualFollowUpFit = retrievalContext === 'contextual'
    && contextIsAvailable(input)
    && Boolean(String(input.pendingQuestion ?? '').trim()) ? 0.08 : 0;
  const latestTurnFit = retrievalContext === 'primary' ? 0.05 : contextualFollowUpFit;
  return semantic * 0.65 + lexical * 0.1 + Math.min(retrieval, 1) * 0.2
    + multiChannel + contextFit + latestTurnFit;
}

function conversationVariable(evidence, requestedKey) {
  const expected = normalize(requestedKey);
  const variables = evidence?.authoritativeData?.variables;
  if (!Array.isArray(variables)) return null;
  return variables.find((variable) => normalize(variable?.key) === expected)?.value ?? null;
}

export function strongCallerMessageMatch(evidence, query, input = {}) {
  if (evidence?.recordType !== 'CONVERSATION_NODE' || evidence?.callerFacing !== true
    || normalize(evidence.authoritativeData?.nodeType) !== 'message') return false;
  const situation = normalize(conversationVariable(evidence, 'situation'));
  if (!situation) return false;
  const context = normalize(conversationVariable(evidence, 'context') ?? 'any')
    .replace(/\s+/gu, '_');
  const selectedEntities = [
    ...(Array.isArray(input.knownEntities) ? input.knownEntities : []),
    ...(Array.isArray(input.understanding?.selectedEntities)
      ? input.understanding.selectedEntities : []),
  ];
  const retrievalContext = evidence.retrievalContext ?? 'primary';
  const contextualLatestTurn = retrievalContext === 'contextual'
    && contextIsAvailable(input)
    && Boolean(String(input.pendingQuestion ?? '').trim());
  // Specific entity turns must be answered from their hydrated records. A
  // generic caller-facing message cannot replace or follow that answer.
  if (selectedEntities.length > 0 && retrievalContext !== 'contextual') return false;
  if (context === 'no_selected_entity'
    && (input.selectedCatalogItemKey || selectedEntities.length > 0)) return false;
  if (context === 'pending_question' && !String(input.pendingQuestion ?? '').trim()) return false;
  if (!['any', 'no_selected_entity', 'pending_question'].includes(context)) return false;
  // EXAMPLES and SITUATION improve the indexed representation, but runtime
  // activation never compares the caller's words with those examples.
  const semanticScore = Number(evidence.semanticScore ?? 0);
  const lexicalScore = Number(evidence.lexicalScore ?? 0);
  const tokenCoverage = Number(evidence.tokenCoverage ?? 0);
  const channels = new Set(evidence.channels ?? []);
  const strongSemanticFloor = Math.min(0.98, Math.max(0.82, env.RAG_RUNTIME_MIN_SCORE + 0.08));
  const strongLexicalMessage = channels.has('bm25')
    && lexicalScore >= 4 && tokenCoverage >= 0.4;
  return (retrievalContext === 'primary' || contextualLatestTurn)
    && ((channels.has('semantic') && semanticScore >= strongSemanticFloor)
      || strongLexicalMessage);
}

export function selectStrongCallerMessage(evidence = [], query = '', input = {}) {
  const candidates = evidence.filter((item) => strongCallerMessageMatch(item, query, input))
    .sort((left, right) => messageSelectionScore(right, query, input)
      - messageSelectionScore(left, query, input)
      || Number(left.rank ?? 0) - Number(right.rank ?? 0));
  const first = candidates[0];
  if (!first) return null;
  const runnerUp = candidates[1];
  const scoreGap = runnerUp ? messageSelectionScore(first, query, input)
    - messageSelectionScore(runnerUp, query, input) : Number.POSITIVE_INFINITY;
  const semanticGap = runnerUp ? Number(first.semanticScore ?? 0)
    - Number(runnerUp.semanticScore ?? 0) : Number.POSITIVE_INFINITY;
  const contextualPendingResolution = Boolean(String(input.pendingQuestion ?? '').trim())
    && first.retrievalContext === 'contextual'
    && (scoreGap > 0 || semanticGap > 0);
  if (runnerUp && scoreGap < 0.04 && semanticGap < 0.025
    && !contextualPendingResolution) {
    return null;
  }
  return first;
}

async function loadScope(auth, input, runtime) {
  const cacheKey = `zea:rag:active-scope:${auth.tenantId}:${input.agentId}:${input.usageDirection}`;
  const cached = await readJson(runtime.cache, cacheKey);
  if (Array.isArray(cached) && cached.length > 0) return cached;
  const scope = await runtime.contextRunner(auth, async (client) => {
    const result = await client.query(activeScopeSql, [auth.tenantId, input.agentId, input.usageDirection]);
    const row = result.rows[0];
    if (!row?.agent_usage) throw new AppError(404, 'Active voice agent was not found', 'RUNTIME_AGENT_NOT_FOUND');
    return Array.isArray(row.knowledge_bases) ? row.knowledge_bases : [];
  });
  if (scope.length > 0 && runtime.cache && (!runtime.cache.status || runtime.cache.status === 'ready')) {
    void deadline(runtime.cache.set(cacheKey, JSON.stringify(scope), 'EX',
      env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS), env.RAG_RUNTIME_CACHE_TIMEOUT_MS, null);
  }
  return scope;
}

async function loadCatalogIdentities(auth, input, scope, runtime) {
  if (!scope.length) return [];
  const revisions = scope.map((item) => `${item.id}:${item.publicationRevision}`).sort().join('|');
  const cacheKey = `zea:rag:catalog-identities:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${hash(revisions)}`;
  const cached = await readJson(runtime.cache, cacheKey);
  if (Array.isArray(cached)) return cached;
  const manifest = scope.map((item) => ({
    knowledge_base_id: item.id, publication_revision: Number(item.publicationRevision),
  }));
  const rows = await runtime.contextRunner(auth, async (client) => {
    const result = await client.query(catalogIdentitySql, [
      auth.tenantId, input.agentId, input.usageDirection, JSON.stringify(manifest),
    ]);
    return result.rows;
  });
  if (runtime.cache && (!runtime.cache.status || runtime.cache.status === 'ready')) {
    void deadline(runtime.cache.set(cacheKey, JSON.stringify(rows)),
      env.RAG_RUNTIME_CACHE_TIMEOUT_MS, null);
  }
  return rows;
}

function catalogIdentityCandidates(resolution) {
  if (resolution?.status !== 'match') return [];
  const items = resolution.entityType === 'category'
    ? resolution.items : [resolution.item];
  return items.filter((item) => item?.id && item?.knowledge_base_id)
    .slice(0, maximumHydratedCategoryChildren)
    .map((item, index) => ({
      recordType: 'CATALOG_ITEM', recordId: item.id,
      knowledgeBaseId: item.knowledge_base_id,
      publicationRevision: Number(item.publication_revision),
      documentId: item.document_id, documentVersionId: item.document_version_id,
      language: 'und', contentPreview: `${item.name ?? ''} ${item.category ?? ''}`.trim(),
      score: Math.max(0.86, Number(resolution.confidence ?? 0)) - index * 0.001,
      semanticScore: 0, lexicalScore: 0,
      tokenCoverage: Number(resolution.confidence ?? 0),
      channels: ['catalog_identity'], retrievalContext: 'primary',
    }));
}

export function callerMessageEligibleForDecision(evidence, query, input = {}) {
  if (strongCallerMessageMatch(evidence, query, input)) return true;
  if (evidence?.recordType !== 'CONVERSATION_NODE' || evidence?.callerFacing !== true
    || normalize(evidence.authoritativeData?.nodeType) !== 'message') return false;
  // Direct speech bypass requires a high confidence margin. The one grounded
  // decision may also choose a lower-margin contextual candidate, but only
  // when the published record provides matching metadata and retrieval has
  // already retained it for an immediately pending question.
  const situation = normalize(conversationVariable(evidence, 'situation'));
  if (!situation || evidence.retrievalContext !== 'contextual'
    || !String(input.pendingQuestion ?? '').trim()) return false;
  const context = normalize(conversationVariable(evidence, 'context') ?? 'any')
    .replace(/\s+/gu, '_');
  const selectedEntities = [
    ...(Array.isArray(input.knownEntities) ? input.knownEntities : []),
    ...(Array.isArray(input.understanding?.selectedEntities)
      ? input.understanding.selectedEntities : []),
  ];
  if (context === 'no_selected_entity'
    && (input.selectedCatalogItemKey || selectedEntities.length > 0)) return false;
  if (context === 'pending_question' && !String(input.pendingQuestion ?? '').trim()) return false;
  return ['any', 'no_selected_entity', 'pending_question'].includes(context);
}

async function semanticCandidates(auth, input, query, scope, runtime) {
  if (!runtime.ragEnabled || !scope.length || !query) return [];
  const vector = await runtime.embed(query, { signal: input.abortSignal });
  // Retrieve a wider semantic discovery set, then apply the stricter runtime
  // evidence threshold after hybrid corroboration. Using the final evidence
  // threshold inside Qdrant hides useful multilingual candidates before BM25
  // can corroborate them.
  const discoveryThreshold = Math.max(0, env.RAG_RUNTIME_MIN_SCORE - 0.12);
  const matches = await runtime.search(auth.tenantId, vector, {
    knowledgeBases: scope.map((item) => ({ id: item.id, publicationRevision: Number(item.publicationRevision) })),
    usageDirection: input.usageDirection, agentId: input.agentId, abortSignal: input.abortSignal,
    limit: QDRANT_SEARCH_LIMIT_MAX, scoreThreshold: discoveryThreshold, recordTypes,
  });
  const allowed = new Map(scope.map((item) => [String(item.id).toLowerCase(), Number(item.publicationRevision)]));
  return matches.filter((match) => {
    const payload = match.payload ?? {};
    return String(payload.tenant_id).toLowerCase() === String(auth.tenantId).toLowerCase()
      && allowed.get(String(payload.knowledge_base_id).toLowerCase()) === Number(payload.publication_revision)
      && recordTypes.includes(String(payload.record_type).toUpperCase())
      && [String(input.usageDirection).toUpperCase(), 'BOTH'].includes(String(payload.agent_usage).toUpperCase());
  }).map((match, index) => ({
    recordType: String(match.payload.record_type).toUpperCase(),
    recordId: match.payload.record_id ?? match.id,
    knowledgeBaseId: match.payload.knowledge_base_id,
    publicationRevision: Number(match.payload.publication_revision),
    documentId: match.payload.document_id,
    documentVersionId: match.payload.document_version_id,
    language: match.payload.language ?? 'und', contentPreview: match.payload.content,
    semanticScore: Number(match.score), channel: 'semantic', channelRank: index + 1,
  }));
}

async function lexicalCandidates(auth, input, query, scope, runtime) {
  const indexes = await Promise.all(scope.map((item) => readJson(runtime.cache,
    sparseIndexCacheKey(auth.tenantId, item.id, Number(item.publicationRevision)))));
  return rankBm25Documents(indexes.filter(Boolean), query, scope, {
    tenantId: auth.tenantId, usageDirection: input.usageDirection,
  });
}

async function retrieveBranch(auth, input, query, scope, runtime) {
  if (!query) return { semantic: [], lexical: [], ranked: [] };
  const observableSemanticSearch = semanticCandidates(auth, input, query, scope, runtime)
    .catch((error) => {
      logger.error({
        err: error,
        tenantId: auth.tenantId,
        agentId: input.agentId,
        knowledgeBaseRevisions: scope.map((item) => ({
          knowledgeBaseId: item.id,
          publicationRevision: Number(item.publicationRevision),
        })),
      }, 'Hybrid semantic retrieval failed');
      return [];
    });
  const [semantic, lexical] = await Promise.all([
    abortable(deadline(
      observableSemanticSearch,
      env.RAG_RUNTIME_SEMANTIC_DEADLINE_MS, [],
    ), input.abortSignal, []),
    abortable(deadline(
      lexicalCandidates(auth, input, query, scope, runtime),
      env.RAG_RUNTIME_CHANNEL_DEADLINE_MS, [],
    ), input.abortSignal, []),
  ]);
  return {
    semantic,
    lexical,
    ranked: mergeAndRerankCandidates(
      semantic, lexical, query, input.language, Math.max(8, Number(input.topK) || 5),
    ),
  };
}

async function hydrate(auth, input, ranked, runtime) {
  if (!ranked.length) return [];
  const manifest = ranked.map((candidate) => ({
    record_type: candidate.recordType, record_id: candidate.recordId,
    knowledge_base_id: candidate.knowledgeBaseId, rank: candidate.rank, score: candidate.score,
  }));
  return runtime.contextRunner(auth, async (client) => {
    const result = await client.query(hydrateEvidenceSql, [
      auth.tenantId, input.agentId, input.usageDirection, JSON.stringify(manifest),
    ]);
    return result.rows;
  });
}

async function catalogCategoryCandidates(auth, input, seed, runtime, limit = 5) {
  const data = seed?.authoritative_data ?? seed?.authoritativeData ?? {};
  if (!seed?.knowledge_base_id || !data.catalogId || !data.categoryKey) return [];
  return runtime.contextRunner(auth, async (client) => {
    const result = await client.query(catalogCategoryCandidatesSql, [
      auth.tenantId, input.agentId, input.usageDirection,
      seed.knowledge_base_id, data.catalogId, data.categoryKey,
      Math.max(1, Math.min(Number(limit) || maximumHydratedCategoryChildren,
        maximumHydratedCategoryChildren)),
    ]);
    return result.rows.filter((row) => row.record_id).map((row, index) => ({
      recordType: 'CATALOG_ITEM', recordId: row.record_id,
      knowledgeBaseId: row.knowledge_base_id, documentId: row.document_id,
      documentVersionId: row.document_version_id, language: row.language ?? 'und',
      score: Math.max(0, Number(seed.score ?? 1) - index * 0.001),
      semanticScore: Number(seed.score ?? 1), lexicalScore: 0, tokenCoverage: 0,
      channels: ['postgres_category'], retrievalContext: 'catalog_category', rank: index + 1,
    }));
  });
}

function catalogCategoryRequestedByLatestTurn(rows = [], query = '') {
  const seed = [...rows].filter((row) => row.record_type === 'CATALOG_ITEM')
    .sort((left, right) => Number(left.rank) - Number(right.rank))[0];
  if (!seed) return false;
  const data = seed.authoritative_data ?? {};
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size) return false;
  const overlap = (values) => [...new Set(values.flatMap((value) => tokens(value)))]
    .filter((token) => queryTokens.has(token)).length;
  const itemAffinity = overlap([data.itemKey, data.name, ...(data.aliases ?? [])]);
  const categoryAffinity = overlap([
    data.categoryKey, data.category, ...(data.categoryAliases ?? []),
  ]);
  // Category identity comes entirely from the published Catalog metadata.
  // No tenant vocabulary or application keyword list is involved.
  return categoryAffinity > 0 && categoryAffinity >= itemAffinity;
}

export function authoritativeEvidenceFromRow(row) {
  return {
    id: `published:${String(row.record_type).toLowerCase()}:${row.record_id}`,
    recordType: row.record_type, recordId: row.record_id,
    tenantId: row.tenant_id, agentId: row.agent_id,
    publicationRevision: Number(row.publication_revision),
    knowledgeBaseId: row.knowledge_base_id, documentId: row.document_id,
    documentVersionId: row.document_version_id, documentName: row.document_name,
    pageNumber: row.source_page_start ?? null, pageEnd: row.source_page_end ?? null,
    language: row.language ?? 'und', content: String(row.content ?? '').trim(),
    callerFacing: row.caller_facing, authoritativeData: row.authoritative_data ?? {},
    score: Number(row.score), rank: Number(row.rank), matchMode: 'hybrid',
    // These flags are asserted only by this PostgreSQL hydration path. The
    // SQL above has already enforced assignment, active publication revision,
    // approved record status, current document version and ready documents.
    hydrationValidated: true,
    publicationValidated: true, knowledgeBaseStatus: 'published', recordStatus: 'approved',
    documentStatus: 'ready', documentVersionStatus: 'ready',
    documentVersionIsCurrent: true,
  };
}

export async function searchHybridPublishedKnowledge(auth, input, dependencies = {}) {
  const startedAt = performance.now();
  const runtime = { ...defaultDependencies, ...dependencies };
  const tenantId = requireTenantId(auth.tenantId);
  // The finalized caller utterance is the authoritative live-turn query.
  // Context is available to the separate follow-up branch and reranker; it
  // must never replace an explicit latest request in the primary search.
  const queries = isolatedRetrievalQueries(input);
  const query = queries.primary;
  if (!query) throw new AppError(400, 'A natural-language knowledge query is required', 'KNOWLEDGE_QUERY_REQUIRED');
  const safeInput = {
    ...input, usageDirection: input.usageDirection ?? 'inbound', language: input.language ?? 'und',
  };
  const scope = await abortable(deadline(
    loadScope({ ...auth, tenantId }, safeInput, runtime), env.RAG_RUNTIME_CHANNEL_DEADLINE_MS, null,
  ), input.abortSignal, null);
  if (scope === null) return {
    operation: 'search_published_knowledge', route: 'hybrid', found: false, sources: [],
    actionEvidence: [], guidanceEvidence: [], entities: [], timedOut: !input.abortSignal?.aborted,
    cancelled: Boolean(input.abortSignal?.aborted), durationMs: performance.now() - startedAt,
  };
  const revisions = scope.map((item) => `${item.id}:${item.publicationRevision}`).sort().join('|');
  const contextCacheScope = JSON.stringify({
    pendingQuestion: safeInput.pendingQuestion ?? null,
    selectedEntities: (safeInput.knownEntities ?? []).map((entity) => ({
      key: entity?.key ?? null, name: entity?.name ?? null, category: entity?.category ?? null,
    })),
  });
  const cacheKey = `zea:rag:hybrid:v10:${tenantId}:${safeInput.agentId}:${safeInput.usageDirection}:${hash(`${revisions}|${query}|${queries.contextual}|${safeInput.language}|${contextCacheScope}`)}`;
  const cached = await readJson(runtime.cache, cacheKey);
  if (cached) return { ...cached, cacheHit: true };
  const retrievalStartedAt = performance.now();
  const primaryBranch = await retrieveBranch(
    { ...auth, tenantId }, safeInput, query, scope, runtime,
  );
  if (input.abortSignal?.aborted) return {
    operation: 'search_published_knowledge', route: 'hybrid', found: false, sources: [],
    actionEvidence: [], guidanceEvidence: [], entities: [], cancelled: true,
    durationMs: performance.now() - startedAt,
  };
  let strongPrimary = retainStrongCandidates(primaryBranch.ranked, query, 8);
  // Resolve an immediately pending question before attempting noisy-STT
  // Catalog identity discovery. Otherwise a compact acknowledgement can be
  // mistaken for an unrelated entity and suppress its configured response.
  let contextPolicy = contextualRetrievalPolicy(safeInput, query, strongPrimary);
  const pendingContextPreferred = contextPolicy.useContext && contextPolicy.preferContext;
  // Semantic retrieval discovers candidates; the published Catalog projection
  // resolves their canonical identity. Run that resolution for every genuine
  // latest-turn request, even when Qdrant already returned a strong Catalog
  // candidate, so all discovery channels enforce the same entity boundary.
  const catalogIdentityDiscoveryNeeded = !pendingContextPreferred;
  let catalogIdentityResolution = null;
  let identityDiscoveryCandidates = [];
  if (catalogIdentityDiscoveryNeeded) {
    const identities = await abortable(deadline(
      loadCatalogIdentities({ ...auth, tenantId }, safeInput, scope, runtime),
      env.RAG_RUNTIME_CHANNEL_DEADLINE_MS, [],
    ), input.abortSignal, []);
    catalogIdentityResolution = classifyCatalogEntityLocally(identities, query);
    identityDiscoveryCandidates = catalogIdentityCandidates(catalogIdentityResolution);
    if (identityDiscoveryCandidates.length) {
      const uniquePrimary = new Map();
      for (const candidate of [...identityDiscoveryCandidates, ...strongPrimary]) {
        const key = candidateKey(candidate);
        const current = uniquePrimary.get(key);
        uniquePrimary.set(key, current ? mergeCandidateSignals(current, candidate) : candidate);
      }
      strongPrimary = [...uniquePrimary.values()].slice(0, 8)
        .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    }
  }
  // A selected entity or pending question resolves compact continuations and
  // weak standalone turns. Strong explicit requests remain primary.
  if (!pendingContextPreferred) {
    contextPolicy = contextualRetrievalPolicy(safeInput, query, strongPrimary);
  }
  const contextualUsed = Boolean(queries.contextual) && contextPolicy.useContext;
  const contextualBranch = contextualUsed
    ? await retrieveBranch(
      { ...auth, tenantId }, safeInput, queries.contextual, scope, runtime,
    )
    : { semantic: [], lexical: [], ranked: [] };
  if (input.abortSignal?.aborted) return {
    operation: 'search_published_knowledge', route: 'hybrid', found: false, sources: [],
    actionEvidence: [], guidanceEvidence: [], entities: [], cancelled: true,
    durationMs: performance.now() - startedAt,
  };
  const vectorBm25Ms = Math.round((performance.now() - retrievalStartedAt) * 100) / 100;
  const rerankStartedAt = performance.now();
  const strongContextual = retainStrongCandidates(
    contextualBranch.ranked, queries.contextual, 8,
  );
  let ranked = prioritizeCandidates(
    strongPrimary,
    strongContextual,
    contextualUsed,
    contextPolicy.preferContext,
    Math.max(8, Number(safeInput.topK ?? 5)),
  );
  const rerankMs = Math.round((performance.now() - rerankStartedAt) * 100) / 100;
  const hydrationStartedAt = performance.now();
  let rows = await abortable(deadline(
    hydrate({ ...auth, tenantId }, safeInput, ranked, runtime), env.RAG_RUNTIME_CHANNEL_DEADLINE_MS, [],
  ), input.abortSignal, []);
  const categoryRequest = catalogIdentityResolution?.status === 'match'
    && catalogIdentityResolution.entityType === 'category'
    || String(safeInput.understanding?.requestType ?? '').toLocaleLowerCase()
    === 'category_request'
    || String(safeInput.requestType ?? '').toLocaleLowerCase() === 'category_request'
    || Boolean(String(safeInput.activeCategoryKey ?? '').trim())
    || catalogCategoryRequestedByLatestTurn(rows, query);
  if (categoryRequest && ranked[0]?.recordType === 'CATALOG_ITEM' && rows.length) {
    const seed = [...rows]
      .filter((row) => row.record_type === 'CATALOG_ITEM')
      .sort((left, right) => Number(left.rank) - Number(right.rank))[0];
    const categoryCandidates = await abortable(deadline(
      catalogCategoryCandidates(
        { ...auth, tenantId }, safeInput, seed, runtime, maximumHydratedCategoryChildren,
      ), env.RAG_RUNTIME_CHANNEL_DEADLINE_MS, [],
    ), input.abortSignal, []);
    if (categoryCandidates.length) {
      const expanded = new Map();
      for (const candidate of [ranked[0], ...categoryCandidates, ...ranked.slice(1)]) {
        const key = candidateKey(candidate);
        if (!expanded.has(key)) expanded.set(key, candidate);
      }
      ranked = [...expanded.values()]
        .slice(0, maximumHydratedCategoryChildren)
        .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
      rows = await abortable(deadline(
        hydrate({ ...auth, tenantId }, safeInput, ranked, runtime),
        env.RAG_RUNTIME_CHANNEL_DEADLINE_MS, [],
      ), input.abortSignal, []);
    }
  }
  const hydrationMs = Math.round((performance.now() - hydrationStartedAt) * 100) / 100;
  const rankedByKey = new Map(ranked.map((candidate) => [candidateKey(candidate), candidate]));
  const hydratedEvidence = rows.map((row) => {
    const item = authoritativeEvidenceFromRow(row);
    const candidate = rankedByKey.get(candidateKey(item)) ?? {};
    return {
      ...item,
      semanticScore: Number(candidate.semanticScore ?? 0),
      lexicalScore: Number(candidate.lexicalScore ?? 0),
      tokenCoverage: Number(candidate.tokenCoverage ?? 0),
      retrievalScore: Number(candidate.score ?? 0),
      retrievalContext: candidate.retrievalContext ?? 'primary',
      semanticRank: Number(candidate.semanticRank ?? 0) || null,
      bm25Rank: Number(candidate.bm25Rank ?? 0) || null,
      channels: Object.freeze([...(candidate.channels ?? [])]),
    };
  }).sort((left, right) => left.rank - right.rank)
    .map((item) => {
      if (item.recordType !== 'WORKFLOW_RULE') return item;
      const activation = latestTurnWorkflowActivation({
        latestUtterance: input.query,
        conditions: item.authoritativeData?.conditions,
      });
      return { ...item, activationAllowed: activation.allowed, activation };
    });
  const evidence = hydratedEvidence.map((item, index) => ({ ...item, rank: index + 1 }));
  const workflowPermittedEvidence = evidence.filter((item) => (
    item.recordType !== 'WORKFLOW_RULE' || item.activationAllowed === true
  ));
  // Select an exact caller-facing message before Catalog focusing so FAQ and
  // category records cannot crowd out a published overview RESPONSE.
  const preferredCallerMessage = selectStrongCallerMessage(
    workflowPermittedEvidence, query, safeInput,
  );
  const catalogFocus = focusAuthoritativeCatalogEvidence(
    workflowPermittedEvidence, {
      ...safeInput,
      preferredCallerMessage,
      catalogIdentityResolved: catalogIdentityResolution?.status === 'match',
    }, safeInput.topK,
  );
  const permittedEvidence = catalogFocus.evidence
    .slice(0, Math.max(1, Math.min(Number(safeInput.topK) || 5, 5)))
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const evidenceConflict = detectEvidenceConflict(permittedEvidence);
  const sources = permittedEvidence.filter((item) => !(
    (item.recordType === 'WORKFLOW_RULE' || item.recordType === 'CONVERSATION_NODE')
    && item.callerFacing !== true
  )).map((item) => ({
    ...item,
    // Caller-facing controls whether content may be spoken; it does not make
    // every retrieved message a valid exact response for this turn. Exact
    // selection also requires published matching metadata and contextual
    // confidence to pass the same generic policy used by retrieval.
    exactCallerResponseEligible: item.recordType === 'CONVERSATION_NODE'
      ? callerMessageEligibleForDecision(item, query, safeInput)
      : false,
  }));
  const actionEvidence = permittedEvidence.filter((item) => (
    item.recordType === 'WORKFLOW_RULE' && item.callerFacing !== true
  ));
  const guidanceEvidence = permittedEvidence.filter((item) => (
    item.recordType === 'CONVERSATION_NODE' && item.callerFacing !== true
  )).sort((left, right) => left.rank - right.rank).slice(0, 1);
  const entities = sources.filter((item) => item.recordType === 'CATALOG_ITEM').map((item) => ({
    id: item.recordId, key: item.authoritativeData.itemKey, name: item.authoritativeData.name,
    category: item.authoritativeData.category, categoryKey: item.authoritativeData.categoryKey,
    parentCategoryKey: item.authoritativeData.parentCategoryKey,
  }));
  const directMessage = evidenceConflict.detected
    ? null : selectStrongCallerMessage(permittedEvidence, query, input);
  const weakCandidatesRejected = primaryBranch.ranked.length + contextualBranch.ranked.length
    - strongPrimary.length - strongContextual.length;
  const rankedKeys = new Set(ranked.map(candidateKey));
  const hydratedKeys = new Set(evidence.map(candidateKey));
  const rejectedByKey = new Map();
  const addRejected = (candidate, reasons) => {
    const key = candidateKey(candidate);
    const current = rejectedByKey.get(key);
    if (!current) rejectedByKey.set(key, traceCandidate(candidate, reasons));
  };
  for (const candidate of primaryBranch.ranked) {
    const reasons = weakCandidateReasons(candidate, query);
    if (reasons.length) addRejected({ ...candidate, retrievalContext: 'primary' }, reasons);
    else if (!rankedKeys.has(candidateKey(candidate))) {
      addRejected({ ...candidate, retrievalContext: 'primary' }, ['outside_top_k']);
    }
  }
  for (const candidate of contextualBranch.ranked) {
    const reasons = weakCandidateReasons(candidate, queries.contextual);
    if (reasons.length) addRejected({ ...candidate, retrievalContext: 'contextual' }, reasons);
    else if (!rankedKeys.has(candidateKey(candidate))) {
      addRejected({ ...candidate, retrievalContext: 'contextual' }, ['outside_top_k']);
    }
  }
  for (const candidate of ranked) {
    if (!hydratedKeys.has(candidateKey(candidate))) addRejected(candidate, ['postgres_hydration_rejected']);
  }
  for (const candidate of evidence) {
    if (candidate.recordType === 'WORKFLOW_RULE' && candidate.activationAllowed !== true) {
      addRejected(candidate, ['workflow_not_activated_by_latest_turn']);
    }
  }
  const responseRouting = resolveConfidenceResponseRoute({
    directMessage, evidence: permittedEvidence, conflict: evidenceConflict,
    rejectedCandidates: weakCandidatesRejected,
  });
  const result = {
    operation: 'search_published_knowledge', route: 'hybrid',
    found: permittedEvidence.length > 0, sources, actionEvidence, guidanceEvidence, entities,
    evidenceIds: permittedEvidence.map((item) => item.id),
    directResponse: directMessage ? {
      id: directMessage.id,
      recordId: directMessage.recordId,
      recordType: directMessage.recordType,
      tenantId: directMessage.tenantId,
      agentId: directMessage.agentId,
      knowledgeBaseId: directMessage.knowledgeBaseId,
      publicationRevision: directMessage.publicationRevision,
      documentId: directMessage.documentId,
      documentVersionId: directMessage.documentVersionId,
      hydrationValidated: directMessage.hydrationValidated,
      documentStatus: directMessage.documentStatus,
      documentVersionStatus: directMessage.documentVersionStatus,
      documentVersionIsCurrent: directMessage.documentVersionIsCurrent,
      callerFacing: directMessage.callerFacing,
      content: directMessage.content,
      authoritativeData: directMessage.authoritativeData,
    } : null,
    responseRouting,
    requestedFacts: Array.isArray(input.requestedFacts) ? input.requestedFacts : [],
    retrieval: {
      semanticCandidates: primaryBranch.semantic.length + contextualBranch.semantic.length,
      lexicalCandidates: primaryBranch.lexical.length + contextualBranch.lexical.length,
      mergedCandidates: ranked.length, hydratedEvidence: evidence.length,
      weakCandidatesRejected,
      contextualAvailable: Boolean(queries.contextual), contextualUsed,
      contextualPreferred: contextPolicy.preferContext,
      compactContextualTurn: contextPolicy.compactTurn,
      conflictDetected: evidenceConflict.detected,
      conflictType: evidenceConflict.type,
      conflictingRecordIds: evidenceConflict.recordIds,
      workflowCandidatesRejected: evidence.filter((item) => (
        item.recordType === 'WORKFLOW_RULE' && item.activationAllowed !== true
      )).length,
      selectedEntityContextCount: Array.isArray(safeInput.knownEntities)
        ? safeInput.knownEntities.length : 0,
      catalogEvidenceFocused: catalogFocus.focused,
      catalogIdentityResolution: catalogIdentityResolution?.status === 'match' ? {
        entityType: catalogIdentityResolution.entityType,
        confidence: catalogIdentityResolution.confidence,
        method: catalogIdentityResolution.method,
      } : null,
      vectorBm25Ms, rerankMs, hydrationMs,
      semanticTimedOut: runtime.ragEnabled
        && primaryBranch.semantic.length + contextualBranch.semantic.length === 0
        && primaryBranch.lexical.length + contextualBranch.lexical.length > 0,
    },
    publicationRevisions: scope.map((item) => ({
      knowledgeBaseId: item.id, publicationRevision: Number(item.publicationRevision),
    })),
    retrievalTrace: {
      primaryQuery: query,
      contextualQuery: contextualUsed ? queries.contextual : null,
      memoryContext: {
        pendingQuestion: safeInput.pendingQuestion ?? null,
        knownEntities: (safeInput.knownEntities ?? []).map((entity) => ({
          key: entity?.key ?? null,
          name: entity?.name ?? null,
          category: entity?.category ?? null,
        })),
      },
      retrievedCandidates: [
        ...identityDiscoveryCandidates.map((candidate) => traceCandidate(candidate)),
        ...primaryBranch.ranked.map((candidate) => traceCandidate({
          ...candidate, retrievalContext: 'primary',
        })),
        ...contextualBranch.ranked.map((candidate) => traceCandidate({
          ...candidate, retrievalContext: 'contextual',
        })),
      ],
      hydratedEvidence: evidence.map((item) => traceCandidate(item)),
      permittedEvidenceIds: permittedEvidence.map((item) => item.id),
      rejectedCandidates: [...rejectedByKey.values()],
      publicationRevisions: scope.map((item) => ({
        knowledgeBaseId: item.id,
        publicationRevision: Number(item.publicationRevision),
      })),
    },
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  if (runtime.cache && (!runtime.cache.status || runtime.cache.status === 'ready')) {
    void deadline(runtime.cache.set(cacheKey, JSON.stringify(result), 'EX',
      env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS), env.RAG_RUNTIME_CACHE_TIMEOUT_MS, null);
  }
  return result;
}

export const hybridRetrievalSql = Object.freeze({
  activeScopeSql, hydrateEvidenceSql, catalogCategoryCandidatesSql, catalogIdentitySql,
});
