import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { embedQuery } from '../rag/embedding.client.js';
import { searchTenantPoints } from '../rag/qdrant.client.js';

const defaultDependencies = {
  contextRunner: withTenantContext,
  embed: embedQuery,
  search: searchTenantPoints,
  cache: redis,
};

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function usageAllowed(configured, requested) {
  return configured === 'both' || configured === requested;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timed(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

async function cacheGet(cache, key) {
  if (!cache) return null;
  if (cache.status && cache.status !== 'ready') return null;
  const value = await timed(cache.get(key), env.RAG_RUNTIME_CACHE_TIMEOUT_MS);
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function cacheSet(cache, key, value, ttl) {
  if (!cache) return;
  if (cache.status && cache.status !== 'ready') return;
  await timed(cache.set(key, JSON.stringify(value), 'EX', ttl), env.RAG_RUNTIME_CACHE_TIMEOUT_MS);
}

const runtimeProfileSql = `
  WITH runtime_agent AS (
    SELECT id, usage_direction
      FROM voice_agents
     WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND deleted_at IS NULL
  ), assigned AS (
    SELECT kb.id, kb.publication_revision, akb.priority,
      EXISTS (
        SELECT 1 FROM knowledge_processing_jobs j
         WHERE j.tenant_id = kb.tenant_id AND j.knowledge_base_id = kb.id
           AND j.job_type = 'index' AND j.status = 'completed'
           AND j.metadata->>'publicationRevision' = kb.publication_revision::text
      ) AS semantic_ready
      FROM runtime_agent a
      JOIN agent_knowledge_bases akb
        ON akb.tenant_id = $1 AND akb.agent_id = a.id
      JOIN knowledge_bases kb
        ON kb.tenant_id = akb.tenant_id AND kb.id = akb.knowledge_base_id
     WHERE kb.deleted_at IS NULL AND kb.status IN ('published', 'partially_failed')
       AND kb.publication_revision > 0
       AND (a.usage_direction = 'both' OR a.usage_direction = $3::agent_usage_direction)
       AND (akb.usage_direction = 'both' OR akb.usage_direction = $3::agent_usage_direction)
       AND (kb.usage_direction = 'both' OR kb.usage_direction = $3::agent_usage_direction)
  )
  SELECT
    (SELECT usage_direction FROM runtime_agent) AS agent_usage,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'publicationRevision', publication_revision,
      'priority', priority, 'semanticReady', semantic_ready
    ) ORDER BY priority, id) FROM assigned), '[]'::jsonb) AS knowledge_bases,
    COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.priority, r.id)
      FROM (
        SELECT w.id, w.knowledge_base_id, w.name, w.intent, w.priority,
          w.action_type, w.action_config, w.response_template
          FROM workflow_rules w JOIN assigned a ON a.id = w.knowledge_base_id
          JOIN knowledge_document_versions v ON v.tenant_id=w.tenant_id AND v.id=w.document_version_id
          JOIN knowledge_documents d ON d.tenant_id=w.tenant_id AND d.id=w.document_id
         WHERE w.tenant_id=$1 AND w.status='approved'
           AND (w.usage_direction='both' OR w.usage_direction=$3::agent_usage_direction)
           AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
           AND d.status='ready' AND d.deleted_at IS NULL
      ) r), '[]'::jsonb) AS workflows,
    COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sequence_order, c.id)
      FROM (
        SELECT f.id, f.knowledge_base_id, f.flow_key, f.node_key, f.node_type,
          f.language, f.sequence_order, f.is_entry, f.content, f.variables, f.transitions
          FROM conversation_flows f JOIN assigned a ON a.id=f.knowledge_base_id
          JOIN knowledge_document_versions v ON v.tenant_id=f.tenant_id AND v.id=f.document_version_id
          JOIN knowledge_documents d ON d.tenant_id=f.tenant_id AND d.id=f.document_id
         WHERE f.tenant_id=$1 AND f.status='approved'
           AND (f.usage_direction='both' OR f.usage_direction=$3::agent_usage_direction)
           AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
           AND d.status='ready' AND d.deleted_at IS NULL
      ) c), '[]'::jsonb) AS conversations,
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.display_order, i.id)
      FROM (
        SELECT si.id, si.knowledge_base_id, si.item_key, si.name, si.description,
          si.price, si.currency, si.display_order,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'key', sa.attribute_key, 'name', sa.display_name, 'value', sa.value
          ) ORDER BY sa.display_order, sa.id) FROM structured_item_attributes sa
           WHERE sa.tenant_id=si.tenant_id AND sa.item_id=si.id), '[]'::jsonb) AS attributes
          FROM structured_items si JOIN assigned a ON a.id=si.knowledge_base_id
          JOIN structured_catalogs sc ON sc.tenant_id=si.tenant_id AND sc.id=si.catalog_id AND sc.status='approved'
          JOIN knowledge_document_versions v ON v.tenant_id=si.tenant_id AND v.id=si.document_version_id
          JOIN knowledge_documents d ON d.tenant_id=si.tenant_id AND d.id=si.document_id
         WHERE si.tenant_id=$1 AND si.status='approved'
           AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
           AND d.status='ready' AND d.deleted_at IS NULL
      ) i), '[]'::jsonb) AS catalog_items,
    COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id)
      FROM (
        SELECT fe.id, fe.knowledge_base_id, fe.question, fe.answer, fe.language
          FROM faq_entries fe JOIN assigned a ON a.id=fe.knowledge_base_id
          JOIN knowledge_document_versions v ON v.tenant_id=fe.tenant_id AND v.id=fe.document_version_id
          JOIN knowledge_documents d ON d.tenant_id=fe.tenant_id AND d.id=fe.document_id
         WHERE fe.tenant_id=$1 AND fe.status='approved'
           AND (fe.usage_direction='both' OR fe.usage_direction=$3::agent_usage_direction)
           AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
           AND d.status='ready' AND d.deleted_at IS NULL
      ) f), '[]'::jsonb) AS faqs`;

async function loadProfile(auth, input, runtime) {
  const key = `zea:rag:profile:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${input.language}`;
  const cached = await cacheGet(runtime.cache, key);
  if (cached) return { profile: cached, cacheHit: true };
  const profile = await runtime.contextRunner(auth, async (client) => {
    const result = await client.query(runtimeProfileSql, [auth.tenantId, input.agentId, input.usageDirection]);
    return result.rows[0];
  });
  if (!profile?.agent_usage) {
    throw new AppError(404, 'Active voice agent was not found', 'RUNTIME_AGENT_NOT_FOUND');
  }
  if (!usageAllowed(profile.agent_usage, input.usageDirection)) {
    throw new AppError(409, 'Agent does not support this call direction', 'RUNTIME_AGENT_DIRECTION_MISMATCH');
  }
  await cacheSet(runtime.cache, key, profile, env.RAG_RUNTIME_PROFILE_CACHE_TTL_SECONDS);
  return { profile, cacheHit: false };
}

function routeResponse(route, record, content, extra = {}) {
  return {
    route,
    found: true,
    content,
    source: {
      recordId: record.id,
      knowledgeBaseId: record.knowledge_base_id,
      ...extra,
    },
  };
}

function workflowRoute(profile, input, normalizedQuery) {
  const target = normalize(input.intent ?? normalizedQuery);
  const record = profile.workflows.find((item) => normalize(item.intent) === target || normalize(item.name) === target);
  if (!record) return null;
  return {
    ...routeResponse('workflow', record, record.response_template ?? record.action_config?.instruction ?? '', {
      intent: record.intent,
    }),
    action: { type: record.action_type, config: record.action_config },
  };
}

function conversationRoute(profile, input) {
  if (input.routeHint !== 'conversation' && !input.flowKey && !input.nodeKey) return null;
  const flowKey = input.flowKey ?? 'main';
  const candidates = profile.conversations.filter((item) => item.flow_key === flowKey
    && (!input.nodeKey || item.node_key === input.nodeKey)
    && (!item.language || item.language === input.language));
  const record = candidates.find((item) => input.nodeKey ? item.node_key === input.nodeKey : item.is_entry) ?? candidates[0];
  if (!record) return null;
  return {
    ...routeResponse('conversation', record, record.content, {
      flowKey: record.flow_key, nodeKey: record.node_key,
    }),
    node: { type: record.node_type, variables: record.variables, transitions: record.transitions },
  };
}

const catalogKeywords = /\b(price|cost|rate|amount|how much|package|plan|tests?|includes?|details?)\b/iu;

function catalogRoute(profile, input, normalizedQuery) {
  if (input.routeHint !== 'catalog' && !catalogKeywords.test(normalizedQuery)) return null;
  const candidates = profile.catalog_items.map((item) => {
    const names = [item.name, item.item_key].map(normalize).filter(Boolean);
    const matched = names.filter((name) => normalizedQuery === name || normalizedQuery.includes(name));
    return { item, score: Math.max(0, ...matched.map((name) => name.length)) };
  }).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score);
  const record = candidates[0]?.item;
  if (!record) return null;
  const price = record.price == null ? null : `${record.currency ?? ''} ${record.price}`.trim();
  const content = [record.name, price, record.description].filter(Boolean).join(' - ');
  return {
    ...routeResponse('catalog', record, content),
    item: {
      key: record.item_key, name: record.name, description: record.description,
      price: record.price, currency: record.currency, attributes: record.attributes,
    },
  };
}

function faqRoute(profile, input, normalizedQuery) {
  const sameLanguage = profile.faqs.filter((item) => item.language === input.language);
  const record = sameLanguage.find((item) => normalize(item.question) === normalizedQuery)
    ?? profile.faqs.find((item) => normalize(item.question) === normalizedQuery);
  return record ? routeResponse('faq', record, record.answer, { question: record.question }) : null;
}

function allowedSemanticKnowledgeBases(profile) {
  return profile.knowledge_bases.filter((item) => item.semanticReady).map((item) => ({
    id: item.id,
    publicationRevision: Number(item.publicationRevision),
  }));
}

async function semanticRoute(auth, profile, input, normalizedQuery, runtime) {
  const knowledgeBases = allowedSemanticKnowledgeBases(profile);
  if (!knowledgeBases.length || !env.RAG_ENABLED) return null;
  const fingerprint = knowledgeBases.map((item) => `${item.id}:${item.publicationRevision}`).join('|');
  const cacheKey = `zea:rag:result:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${hash(`${fingerprint}|${normalizedQuery}`)}`;
  const cached = await cacheGet(runtime.cache, cacheKey);
  if (cached) return { ...cached, cacheHit: true };
  const vector = await runtime.embed(input.query);
  const rawMatches = await runtime.search(auth.tenantId, vector, {
    knowledgeBases,
    usageDirection: input.usageDirection,
    limit: input.topK ?? env.RAG_RUNTIME_TOP_K,
    scoreThreshold: env.RAG_RUNTIME_MIN_SCORE,
  });
  const allowed = new Map(knowledgeBases.map((item) => [item.id.toLowerCase(), item.publicationRevision]));
  const matches = rawMatches.filter((match) => {
    const payload = match.payload ?? {};
    return payload.tenant_id === auth.tenantId.toLowerCase()
      && allowed.get(String(payload.knowledge_base_id).toLowerCase()) === payload.publication_revision
      && [input.usageDirection.toUpperCase(), 'BOTH'].includes(payload.agent_usage)
      && ['FAQ', 'KNOWLEDGE_CHUNK'].includes(payload.record_type);
  }).map((match) => ({
    id: match.id,
    score: Number(match.score),
    content: match.payload.content,
    question: match.payload.question ?? null,
    answer: match.payload.answer ?? null,
    recordType: match.payload.record_type,
    knowledgeBaseId: match.payload.knowledge_base_id,
    documentId: match.payload.document_id,
    pageNumber: match.payload.page_number ?? null,
  }));
  if (!matches.length) return null;
  const result = {
    route: 'semantic',
    found: true,
    content: matches[0].answer ?? matches[0].content,
    source: {
      recordId: matches[0].id,
      knowledgeBaseId: matches[0].knowledgeBaseId,
      documentId: matches[0].documentId,
      pageNumber: matches[0].pageNumber,
    },
    matches,
    cacheHit: false,
  };
  await cacheSet(runtime.cache, cacheKey, result, env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS);
  return result;
}

export async function routeKnowledgeQuery(auth, input, dependencies = defaultDependencies) {
  const startedAt = performance.now();
  const runtime = { ...defaultDependencies, ...dependencies };
  const normalizedQuery = normalize(input.query);
  const loaded = await loadProfile(auth, input, runtime);
  const { profile } = loaded;
  let result = null;

  if (input.routeHint === 'auto' || input.routeHint === 'workflow') {
    result = workflowRoute(profile, input, normalizedQuery);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'conversation')) {
    result = conversationRoute(profile, input);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'catalog')) {
    result = catalogRoute(profile, input, normalizedQuery);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'faq')) {
    result = faqRoute(profile, input, normalizedQuery);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'semantic')) {
    result = await semanticRoute(auth, profile, input, normalizedQuery, runtime);
  }

  return {
    ...(result ?? { route: 'none', found: false, content: null, source: null }),
    profileCacheHit: loaded.cacheHit,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

export async function invalidateTenantKnowledgeCache(tenantId, cache = redis) {
  if (!cache || (cache.status && cache.status !== 'ready')) return { deletedKeys: 0 };
  let cursor = '0';
  let deletedKeys = 0;
  const patterns = [`zea:rag:profile:${tenantId}:*`, `zea:rag:result:${tenantId}:*`];
  try {
    for (const pattern of patterns) {
      cursor = '0';
      do {
        const response = await timed(
          cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100),
          env.RAG_RUNTIME_CACHE_TIMEOUT_MS,
        );
        if (!response) break;
        cursor = response[0];
        const keys = response[1];
        if (keys.length) {
          const removed = await timed(cache.del(...keys), env.RAG_RUNTIME_CACHE_TIMEOUT_MS);
          deletedKeys += Number(removed ?? 0);
        }
      } while (cursor !== '0');
    }
  } catch {
    return { deletedKeys, incomplete: true };
  }
  return { deletedKeys };
}
