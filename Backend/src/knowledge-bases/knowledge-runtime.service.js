import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { redis } from '../infrastructure/redis.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { embedQuery } from '../rag/embedding.client.js';
import { searchTenantPoints } from '../rag/qdrant.client.js';
import { requireTenantId } from '../rag/tenant-isolation.js';
import {
  catalogLabelSimilarity,
  classifyCatalogEntityLocally,
} from './catalog-entity-resolver.js';
import { workflowStageGate } from '../voice/interaction/conversation-stage-config.js';
import {
  renderKnowledgeClarification,
  resolveKnowledgeConfidenceConfiguration,
} from './knowledge-confidence-config.js';

const defaultDependencies = {
  contextRunner: withTenantContext,
  embed: embedQuery,
  search: searchTenantPoints,
  cache: redis,
};

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
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
    SELECT id, usage_direction, settings
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
    (SELECT settings FROM runtime_agent) AS agent_settings,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'publicationRevision', publication_revision,
      'priority', priority, 'semanticReady', semantic_ready
    ) ORDER BY priority, id) FROM assigned), '[]'::jsonb) AS knowledge_bases,
    COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.priority, r.id)
      FROM (
        SELECT w.id, w.knowledge_base_id, w.document_id, w.document_version_id,
          d.original_filename AS document_name, w.source_page_start, w.source_page_end,
          w.name, w.intent, w.priority, w.conditions, w.action_type, w.action_config, w.response_template
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
        SELECT f.id, f.knowledge_base_id, f.document_id, f.document_version_id,
          d.original_filename AS document_name, f.source_page_start, f.source_page_end,
          f.flow_key, f.node_key, f.node_type, f.language, f.sequence_order,
          f.is_entry, f.content, f.variables, f.transitions
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
        SELECT si.id, si.knowledge_base_id, si.document_id, si.document_version_id,
          d.original_filename AS document_name, si.source_page_start, si.source_page_end,
          si.item_key, si.name, si.category, si.aliases, sc.name AS catalog_name,
          si.description, si.price, si.currency, si.display_order,
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
        SELECT fe.id, fe.knowledge_base_id, fe.document_id, fe.document_version_id,
          d.original_filename AS document_name, fe.source_page_start, fe.source_page_end,
          fe.question, fe.answer, fe.language
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
      documentId: record.document_id,
      documentVersionId: record.document_version_id,
      documentName: record.document_name,
      pageNumber: record.source_page_start,
      pageEnd: record.source_page_end,
      ...extra,
    },
  };
}

function clarificationResponse(record, configuration, candidates, details = {}) {
  const names = candidates.map((candidate) => candidate.name ?? candidate.matchedPhrase).filter(Boolean);
  const content = renderKnowledgeClarification(configuration.clarificationMessage, names);
  if (!record || !content) return null;
  return {
    ...routeResponse('clarification', record, content, {
      confidence: details.confidence,
      clarificationKind: details.kind,
    }),
    clarification: {
      kind: details.kind,
      confidence: details.confidence,
      reason: details.reason ?? 'uncertain_match',
      candidates: candidates.slice(0, 3),
    },
  };
}

function workflowRoute(profile, input, normalizedQuery, currentCatalogResolution = null) {
  const target = normalize(input.intent ?? normalizedQuery);
  const confidence = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const ranked = [];
  for (const record of profile.workflows) {
    const phrases = Array.isArray(record.conditions?.triggerPhrases)
      ? record.conditions.triggerPhrases.map((phrase) => ({
        original: String(phrase).trim(), normalized: normalize(phrase),
      })).filter((phrase) => phrase.normalized)
      : [];
    const matchMode = String(record.conditions?.matchMode ?? 'any_phrase').trim().toLowerCase();
    let phraseResult = null;
    if (phrases.length) {
      for (const phrase of phrases) {
        let score = normalizedQuery === phrase.normalized ? 1 : 0;
        let method = score ? 'normalized' : 'none';
        if (!score && ['contains', 'any_phrase'].includes(matchMode)
          && ` ${normalizedQuery} `.includes(` ${phrase.normalized} `)) {
          score = 0.99; method = 'contains';
        }
        if (!score && matchMode !== 'exact') {
          const fuzzy = catalogLabelSimilarity(input.query, phrase.original);
          score = fuzzy.score; method = fuzzy.method;
        }
        if (!phraseResult || score > phraseResult.score) {
          phraseResult = { matchedPhrase: phrase.original, score, method };
        }
      }
    } else if (normalize(record.intent) === target || normalize(record.name) === target) {
      phraseResult = { matchedPhrase: input.intent ?? record.intent ?? record.name, score: 1, method: 'intent' };
    }
    if (phraseResult?.score > 0) {
      const gate = workflowStageGate(record, {
        currentStage: input.currentStage,
        selectedCatalogItemId: input.selectedCatalogItemId ?? currentCatalogResolution?.item?.id,
      });
      if (gate.reason === 'stage_transition_not_allowed') continue;
      ranked.push({ record, ...phraseResult, matchMode: phrases.length ? matchMode : 'legacy_intent', gate });
    }
  }
  ranked.sort((left, right) => right.score - left.score
    || Number(left.record.priority ?? 100) - Number(right.record.priority ?? 100));
  const match = ranked[0];
  if (!match || match.score < confidence.clarificationConfidence) return null;
  const runnerUp = ranked.find((candidate) => candidate.record.id !== match.record.id);
  const ambiguous = Boolean(runnerUp && match.score - runnerUp.score < confidence.ambiguityMargin);
  if (match.score < confidence.highConfidence || ambiguous) {
    return clarificationResponse(match.record, confidence, ranked.map((candidate) => ({
      recordId: candidate.record.id,
      name: candidate.record.name,
      matchedPhrase: candidate.matchedPhrase,
      confidence: Math.round(candidate.score * 10000) / 10000,
    })), {
      kind: 'workflow', confidence: Math.round(match.score * 10000) / 10000,
      reason: ambiguous ? 'ambiguous_match' : 'low_confidence',
    });
  }
  const { record, matchedPhrase, matchMode, gate } = match;
  const responseMode = String(record.action_config?.responseMode ?? 'instruction').trim().toLowerCase();
  const blockedResponse = String(record.action_config?.blockedResponse ?? '').trim();
  const content = gate.allowed ? (record.response_template ?? record.action_config?.instruction ?? '') : blockedResponse;
  if (!content) return null;
  return {
    ...routeResponse('workflow', record, content, {
      intent: record.intent, matchedPhrase, matchMode, responseMode,
    }),
    action: { type: record.action_type, config: record.action_config },
    workflow: {
      intent: record.intent,
      conditions: record.conditions,
      matchedPhrase,
      matchMode,
      responseMode,
      exactResponse: record.action_type === 'respond' && responseMode === 'exact',
      gate,
      confidence: Math.round(match.score * 10000) / 10000,
      matchMethod: match.method,
    },
  };
}

export function isExactWorkflowResponse(result) {
  return result?.found === true
    && result.route === 'workflow'
    && result.workflow?.exactResponse === true
    && Boolean(String(result.content ?? '').trim());
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

const catalogKeywords = /\b(price|cost|rate|amount|how much|package|plan|product|service|tests?|includes?|details?)\b/iu;

function catalogResponse(record, resolution) {
  const price = record.price == null ? null : `${record.currency ?? ''} ${record.price}`.trim();
  const content = [record.name, price, record.description].filter(Boolean).join(' - ');
  return {
    ...routeResponse('catalog', record, content, {
      entityResolutionMethod: resolution.method,
      entityResolutionConfidence: resolution.confidence,
      matchedEntityText: resolution.matchedText,
    }),
    item: {
      key: record.item_key, name: record.name, category: record.category ?? record.catalog_name,
      aliases: record.aliases, description: record.description,
      price: record.price, currency: record.currency, attributes: record.attributes,
    },
    entityResolution: {
      method: resolution.method,
      confidence: resolution.confidence,
      matchedText: resolution.matchedText,
      matchedKind: resolution.matchedKind ?? 'name',
    },
  };
}

function catalogCategoryResponse(records, resolution) {
  const record = records[0];
  const category = resolution.category ?? record?.category ?? record?.catalog_name;
  const names = records.map((item) => item.name);
  return {
    ...routeResponse('catalog', record, `${category}: ${names.join(', ')}`, {
      entityResolutionMethod: resolution.method,
      entityResolutionConfidence: resolution.confidence,
      matchedEntityText: resolution.matchedText,
    }),
    category: {
      name: category,
      items: records.map((item) => ({
        key: item.item_key,
        name: item.name,
        aliases: item.aliases,
        description: item.description,
        price: item.price,
        currency: item.currency,
        attributes: item.attributes,
      })),
    },
    entityResolution: {
      method: resolution.method,
      confidence: resolution.confidence,
      matchedText: resolution.matchedText,
      matchedKind: 'category',
    },
  };
}

async function semanticCatalogResolution(auth, profile, input, normalizedQuery, runtime) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const knowledgeBases = allowedSemanticKnowledgeBases(profile);
  if (!knowledgeBases.length || !env.RAG_ENABLED) return null;
  const shortQuery = normalizedQuery.split(' ').length <= 4;
  if (input.routeHint !== 'catalog' && !catalogKeywords.test(normalizedQuery) && !shortQuery) return null;
  const fingerprint = knowledgeBases.map((item) => `${item.id}:${item.publicationRevision}`).join('|');
  const cacheKey = `zea:rag:entity:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${hash(`${fingerprint}|${normalizedQuery}`)}`;
  const cached = await cacheGet(runtime.cache, cacheKey);
  if (cached) return cached;
  const vector = await runtime.embedQueryOnce(input.query);
  const rawMatches = await runtime.search(auth.tenantId, vector, {
    knowledgeBases,
    usageDirection: input.usageDirection,
    limit: 3,
    scoreThreshold: Math.min(env.RAG_RUNTIME_MIN_SCORE, confidenceConfiguration.clarificationConfidence),
    recordTypes: ['CATALOG_ITEM'],
  });
  const allowed = new Map(knowledgeBases.map((item) => [item.id.toLowerCase(), item.publicationRevision]));
  const matches = rawMatches.filter((match) => {
    const payload = match.payload ?? {};
    return payload.tenant_id === auth.tenantId.toLowerCase()
      && allowed.get(String(payload.knowledge_base_id).toLowerCase()) === payload.publication_revision
      && [input.usageDirection.toUpperCase(), 'BOTH'].includes(payload.agent_usage)
      && payload.record_type === 'CATALOG_ITEM';
  }).sort((left, right) => Number(right.score) - Number(left.score));
  const best = matches[0];
  const runnerUp = matches[1];
  if (!best) return null;
  const bestScore = Number(best.score);
  if (bestScore < confidenceConfiguration.clarificationConfidence) return null;
  const closeRunnerUp = runnerUp
    && bestScore - Number(runnerUp.score) < confidenceConfiguration.ambiguityMargin;
  const sharedCategory = closeRunnerUp
    && best.payload?.entity_category
    && normalize(best.payload.entity_category) === normalize(runnerUp.payload?.entity_category);
  if (closeRunnerUp && !sharedCategory) {
    const resolution = {
      status: 'uncertain',
      confidence: Math.round(bestScore * 10000) / 10000,
      candidates: matches.slice(0, 3).map((match) => ({
        itemId: match.id,
        name: match.payload?.entity_name,
        confidence: Math.round(Number(match.score) * 10000) / 10000,
      })),
      reason: 'ambiguous_match',
    };
    await cacheSet(runtime.cache, cacheKey, resolution, env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS);
    return resolution;
  }
  if (sharedCategory) {
    const resolution = {
      status: bestScore >= confidenceConfiguration.highConfidence ? 'match' : 'uncertain',
      entityType: 'category',
      category: best.payload.entity_category,
      method: 'semantic',
      confidence: Math.round(Number(best.score) * 10000) / 10000,
      matchedText: best.payload.entity_category,
      matchedKind: 'category',
      candidates: [{ name: best.payload.entity_category, confidence: Math.round(bestScore * 10000) / 10000 }],
    };
    await cacheSet(runtime.cache, cacheKey, resolution, env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS);
    return resolution;
  }
  const record = profile.catalog_items.find((item) => String(item.id).toLowerCase() === String(best.id).toLowerCase());
  if (!record) return null;
  const resolution = {
    status: bestScore >= confidenceConfiguration.highConfidence ? 'match' : 'uncertain',
    entityType: 'item',
    itemId: record.id,
    method: 'semantic',
    confidence: Math.round(Number(best.score) * 10000) / 10000,
    matchedText: best.payload?.entity_name ?? record.name,
    matchedKind: 'semantic',
    candidates: matches.slice(0, 3).map((match) => ({
      itemId: match.id,
      name: match.payload?.entity_name,
      confidence: Math.round(Number(match.score) * 10000) / 10000,
    })),
  };
  await cacheSet(runtime.cache, cacheKey, resolution, env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS);
  return resolution;
}

async function catalogRoute(auth, profile, input, normalizedQuery, runtime, localClassification = null) {
  const confidence = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const local = localClassification ?? classifyCatalogEntityLocally(profile.catalog_items, input.query, confidence);
  if (local.status === 'match') {
    if (local.entityType === 'category') {
      const records = [...local.items].sort((left, right) => Number(left.display_order ?? 0) - Number(right.display_order ?? 0));
      return records.length ? catalogCategoryResponse(records, local) : null;
    }
    return catalogResponse(local.item, local);
  }
  const semantic = await semanticCatalogResolution(auth, profile, input, normalizedQuery, runtime);
  const resolution = semantic?.status === 'match' ? semantic : null;
  const uncertain = [local.status === 'uncertain' ? local : null, semantic?.status === 'uncertain' ? semantic : null]
    .filter(Boolean).sort((left, right) => Number(right.confidence) - Number(left.confidence))[0];
  if (!resolution) {
    if (!uncertain) return null;
    const candidateItems = uncertain.candidates ?? [];
    const record = profile.catalog_items.find((item) => (
      String(item.id).toLowerCase() === String(candidateItems[0]?.itemId ?? '').toLowerCase()
      || item.name === candidateItems[0]?.name
      || normalize(item.category ?? item.catalog_name) === normalize(candidateItems[0]?.category ?? candidateItems[0]?.name)
    )) ?? profile.catalog_items[0];
    return clarificationResponse(record, confidence, candidateItems, {
      kind: 'catalog', confidence: uncertain.confidence,
      reason: uncertain.reason ?? (uncertain.ambiguous ? 'ambiguous_match' : 'low_confidence'),
    });
  }
  if (resolution.entityType === 'category') {
    const categoryKey = normalize(resolution.category);
    const records = profile.catalog_items.filter((item) => (
      normalize(item.category ?? item.catalog_name) === categoryKey
    )).sort((left, right) => Number(left.display_order ?? 0) - Number(right.display_order ?? 0));
    return records.length ? catalogCategoryResponse(records, resolution) : null;
  }
  const record = profile.catalog_items.find((item) => String(item.id).toLowerCase() === String(resolution.itemId).toLowerCase());
  return record ? catalogResponse(record, resolution) : null;
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
  const vector = await runtime.embedQueryOnce(input.query);
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
  let queryVectorPromise = null;
  runtime.embedQueryOnce = (query) => {
    queryVectorPromise ??= runtime.embed(query);
    return queryVectorPromise;
  };
  const normalizedQuery = normalize(input.query);
  const loaded = await loadProfile(auth, input, runtime);
  const { profile } = loaded;
  const confidence = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const currentCatalogClassification = classifyCatalogEntityLocally(profile.catalog_items, input.query, confidence);
  const currentCatalogResolution = currentCatalogClassification.status === 'match'
    ? currentCatalogClassification : null;
  let result = null;

  if (input.routeHint === 'auto' || input.routeHint === 'workflow') {
    result = workflowRoute(profile, input, normalizedQuery, currentCatalogResolution);
    if (result && currentCatalogResolution?.entityType === 'item') {
      result.catalogSelection = catalogResponse(currentCatalogResolution.item, currentCatalogResolution);
    }
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'conversation')) {
    result = conversationRoute(profile, input);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'catalog')) {
    result = await catalogRoute(auth, profile, input, normalizedQuery, runtime, currentCatalogClassification);
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
  const tenant = requireTenantId(tenantId);
  if (!cache || (cache.status && cache.status !== 'ready')) {
    return { deletedKeys: 0, incomplete: true };
  }
  let deletedKeys = 0;
  const patterns = [
    `zea:rag:profile:${tenant}:*`,
    `zea:rag:result:${tenant}:*`,
    `zea:rag:entity:${tenant}:*`,
  ];
  try {
    for (const pattern of patterns) {
      let cleared = false;
      for (let pass = 0; pass < 3 && !cleared; pass += 1) {
        let cursor = '0';
        let foundThisPass = 0;
        do {
          const response = await timed(
            cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100),
            env.RAG_RUNTIME_CACHE_TIMEOUT_MS,
          );
          if (!Array.isArray(response) || response.length < 2 || !Array.isArray(response[1])) {
            return { deletedKeys, incomplete: true };
          }
          cursor = String(response[0]);
          const keys = response[1];
          foundThisPass += keys.length;
          if (keys.length) {
            const removed = await timed(cache.del(...keys), env.RAG_RUNTIME_CACHE_TIMEOUT_MS);
            if (removed === null) return { deletedKeys, incomplete: true };
            deletedKeys += Number(removed ?? 0);
          }
        } while (cursor !== '0');
        cleared = foundThisPass === 0;
      }
      if (!cleared) return { deletedKeys, incomplete: true };
    }
  } catch {
    return { deletedKeys, incomplete: true };
  }
  return { deletedKeys, verified: true, remainingKeys: 0 };
}
