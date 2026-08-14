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
  resolveCatalogEntitiesLocally,
} from './catalog-entity-resolver.js';
import { workflowStageGate } from '../voice/interaction/conversation-stage-config.js';
import {
  renderKnowledgeClarification,
  resolveKnowledgeConfidenceConfiguration,
} from './knowledge-confidence-config.js';
import {
  rankHybridEvidence,
  rankedEvidenceBundle,
  resolveEvidenceConfidence,
  validateDirectAnswer,
} from './hybrid-evidence-ranker.js';
import { runParallelHybridRetrieval } from './parallel-hybrid-retrieval.js';
import { knowledgeMapCacheKey } from './knowledge-map.service.js';

const defaultDependencies = {
  contextRunner: withTenantContext,
  embed: embedQuery,
  search: searchTenantPoints,
  cache: redis,
  ragEnabled: env.RAG_ENABLED,
};
const RUNTIME_ABORTED = Symbol('RUNTIME_ABORTED');
const RUNTIME_TIMED_OUT = Symbol('RUNTIME_TIMED_OUT');

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

function withinDeadline(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(RUNTIME_TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return RUNTIME_ABORTED;
  let abortHandler;
  const aborted = new Promise((resolve) => {
    abortHandler = () => resolve(RUNTIME_ABORTED);
    signal.addEventListener('abort', abortHandler, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', abortHandler); }
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
    SELECT kb.id,
      COALESCE((
        SELECT max((j.metadata->>'publicationRevision')::int)
          FROM knowledge_processing_jobs j
         WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
           AND j.job_type='index' AND j.status='completed'
           AND (j.metadata->>'publicationRevision') ~ '^[0-9]+$'
           AND (j.metadata->>'publicationRevision')::int <= kb.publication_revision
      ), kb.publication_revision) AS publication_revision,
      akb.priority,
      EXISTS (
        SELECT 1 FROM knowledge_processing_jobs j
         WHERE j.tenant_id = kb.tenant_id AND j.knowledge_base_id = kb.id
           AND j.job_type = 'index' AND j.status = 'completed'
           AND (j.metadata->>'publicationRevision') ~ '^[0-9]+$'
           AND (j.metadata->>'publicationRevision')::int <= kb.publication_revision
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
          si.item_key, si.name, si.category, si.category_key, si.parent_category_key,
          si.category_description, si.category_selection_rules,
          si.category_aliases, si.aliases, si.relationships, si.selection_rules,
          sc.name AS catalog_name,
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
      ) f), '[]'::jsonb) AS faqs,
    COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.chunk_index, g.id)
      FROM (
        SELECT c.id, c.knowledge_base_id, c.document_id, c.document_version_id,
          d.original_filename AS document_name, c.source_page_start, c.source_page_end,
          c.chunk_index, c.source_heading, c.content
          FROM knowledge_chunks c JOIN assigned a ON a.id=c.knowledge_base_id
          JOIN knowledge_document_versions v ON v.tenant_id=c.tenant_id AND v.id=c.document_version_id
          JOIN knowledge_documents d ON d.tenant_id=c.tenant_id AND d.id=c.document_id
         WHERE c.tenant_id=$1 AND c.status='approved'
           AND (c.usage_direction='both' OR c.usage_direction=$3::agent_usage_direction)
           AND v.is_current=true AND v.status='ready' AND v.deleted_at IS NULL
           AND d.status='ready' AND d.deleted_at IS NULL
      ) g), '[]'::jsonb) AS general_knowledge`;

function lexicalTokens(value) {
  return normalize(value).split(' ').filter((token) => token.length > 1);
}

function buildCachedDocumentIndex(profile) {
  if (profile?.lexical_index?.version === 1 && Array.isArray(profile.lexical_index.documents)) return profile;
  const documents = [];
  const add = (recordType, record, searchableText, content) => {
    const tokens = lexicalTokens(searchableText);
    const spoken = String(content ?? '').trim();
    if (!tokens.length || !spoken) return;
    documents.push({
      id: record.id,
      recordType,
      knowledgeBaseId: record.knowledge_base_id,
      documentId: record.document_id,
      documentVersionId: record.document_version_id,
      documentName: record.document_name,
      pageNumber: record.source_page_start,
      pageEnd: record.source_page_end,
      content: spoken,
      tokens,
    });
  };
  for (const item of profile.catalog_items ?? []) {
    add('CATALOG_ITEM', item, [
      item.name, item.item_key, item.category, item.category_key, item.parent_category_key,
      ...(item.aliases ?? []), ...(item.category_aliases ?? []), item.description,
    ].filter(Boolean).join(' '), evidenceItemContent(item));
  }
  for (const workflow of profile.workflows ?? []) {
    const responseMode = String(workflow.action_config?.responseMode ?? 'instruction').trim().toLowerCase();
    if (responseMode === 'instruction') continue;
    add('WORKFLOW_RULE', workflow, [
      workflow.name, workflow.intent, ...(workflow.conditions?.triggerPhrases ?? []),
    ].filter(Boolean).join(' '), workflow.response_template);
  }
  for (const node of profile.conversations ?? []) {
    add('CONVERSATION_NODE', node, [node.flow_key, node.node_key, node.content].join(' '), node.content);
  }
  for (const faq of profile.faqs ?? []) {
    add('FAQ', faq, `${faq.question ?? ''} ${faq.answer ?? ''}`, faq.answer);
  }
  for (const chunk of profile.general_knowledge ?? []) {
    add('KNOWLEDGE_CHUNK', chunk, `${chunk.source_heading ?? ''} ${chunk.content ?? ''}`, chunk.content);
  }
  const documentFrequency = {};
  for (const document of documents) {
    for (const token of new Set(document.tokens)) documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
  }
  profile.lexical_index = { version: 1, documents, documentFrequency };
  return profile;
}

async function loadProfile(auth, input, runtime) {
  const key = `zea:rag:profile:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${input.language}`;
  const cached = await cacheGet(runtime.cache, key);
  if (cached) return { profile: buildCachedDocumentIndex(cached), cacheHit: true };
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
  buildCachedDocumentIndex(profile);
  void cacheSet(runtime.cache, key, profile, env.RAG_RUNTIME_PROFILE_CACHE_TTL_SECONDS)
    .catch(() => undefined);
  return { profile, cacheHit: false };
}
//
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
  const names = candidates.map((candidate) => candidate.matchedPhrase ?? candidate.name).filter(Boolean);
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

function workflowMatchTier(method) {
  if (method === 'exact' || method === 'intent') return 4;
  if (method === 'contains') return 3;
  if (method === 'normalized') return 2;
  if (method === 'phonetic' || method === 'fuzzy') return 1;
  return 0;
}

function isStrongWorkflowMethod(method) {
  // Only a literal configured phrase, a complete configured intent, or an
  // explicit phrase contained in the caller's final sentence may directly
  // execute/speak a Workflow. Normalized, phonetic and fuzzy similarity are
  // useful retrieval signals, but must never become caller-facing decisions.
  return ['exact', 'contains', 'intent'].includes(method);
}

function workflowPhraseSpecificity(value) {
  return normalize(value).split(' ').filter(Boolean).length;
}

function workflowRecordResponse(record, {
  matchedPhrase, matchMode, gate, confidence, method,
} = {}) {
  const responseMode = String(record.action_config?.responseMode ?? 'instruction').trim().toLowerCase();
  const blockedResponse = String(record.action_config?.blockedResponse ?? '').trim();
  const instruction = String(record.response_template ?? record.action_config?.instruction ?? '').trim();
  // Instruction mode is machine-facing only. It can open an action gate or
  // guide a generated response, but its text must never be exposed as caller
  // audio. A blocked response is explicitly tenant-authored caller speech.
  const content = gate?.allowed === false
    ? blockedResponse
    : (responseMode === 'instruction' ? '' : instruction);
  if (!content && responseMode !== 'instruction') return null;
  return {
    ...routeResponse('workflow', record, content, {
      intent: record.intent, matchedPhrase, matchMode, responseMode,
    }),
    action: { type: record.action_type, config: record.action_config },
    workflow: {
      intent: record.intent,
      priority: record.priority,
      conditions: record.conditions,
      matchedPhrase,
      matchMode,
      responseMode,
      instruction: responseMode === 'instruction' ? instruction : null,
      exactResponse: record.action_type === 'respond' && responseMode === 'exact',
      deterministic: isStrongWorkflowMethod(method) || method === 'confidence_outcome',
      gate,
      confidence,
      matchMethod: method,
    },
    directAnswer: responseMode === 'exact' && Boolean(content)
      ? { approved: true, matchMethod: method, sourceType: 'workflow' }
      : null,
  };
}

function workflowEvidenceHint(profile, record, {
  matchedPhrase, matchMode, gate, confidence, method,
} = {}) {
  const responseMode = String(record.action_config?.responseMode ?? 'instruction').trim().toLowerCase();
  const evidence = responseMode === 'instruction'
    ? ''
    : String(record.response_template ?? record.action_config?.instruction ?? '').trim();
  const hint = {
    ...routeResponse('workflow_hint', record, evidence, {
      intent: record.intent, matchedPhrase, matchMode, responseMode,
    }),
    action: { type: record.action_type, config: record.action_config },
    workflow: {
      intent: record.intent,
      priority: record.priority,
      conditions: record.conditions,
      matchedPhrase,
      matchMode,
      responseMode,
      evidenceOnly: true,
      gate,
      confidence,
      matchMethod: method,
    },
  };
  return withScenarioTarget(profile, record, hint);
}

function scenarioTarget(profile, record) {
  if (record.conditions?.scenarioRouting !== true) return null;
  const config = record.action_config ?? {};
  const itemKey = normalize(config.scenarioTargetItemKey);
  const categoryKey = normalize(config.scenarioTargetCategoryKey);
  const item = itemKey ? profile.catalog_items.find((entry) => normalize(entry.item_key) === itemKey) : null;
  if (item) return { type: 'item', item };
  const items = categoryKey ? profile.catalog_items.filter((entry) => normalize(entry.category_key) === categoryKey) : [];
  if (!items.length) return null;
  return {
    type: 'category',
    category: items[0].category ?? items[0].catalog_name,
    categoryKey: items[0].category_key,
    parentCategoryKey: items[0].parent_category_key ?? null,
    items,
  };
}

function withScenarioTarget(profile, record, response) {
  const target = scenarioTarget(profile, record);
  if (!target) return response;
  if (target.type === 'item') return { ...response, catalogSelection: catalogResponse(target.item, {
    method: 'workflow_target', confidence: 1, matchedText: target.item.name, matchedKind: 'scenario_target',
  }) };
  return { ...response, scenarioCategory: {
    key: target.categoryKey, name: target.category, parentKey: target.parentCategoryKey,
    items: target.items.map((item) => ({
      id: item.id, key: item.item_key, name: item.name, category: item.category,
      categoryKey: item.category_key, parentCategoryKey: item.parent_category_key,
    })),
  } };
}

function workflowRoute(profile, input, normalizedQuery, currentCatalogResolution = null, {
  includeScenarioRules = true,
} = {}) {
  const target = normalize(input.intent ?? normalizedQuery);
  const confidence = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const ranked = [];
  for (const record of profile.workflows) {
    if (record.conditions?.confidenceOutcome) continue;
    const detectedScenario = input.detectedIntent?.intent === 'scenario';
    // Scenario Rules are activated only for an actual scenario/use-case turn.
    // They remain entirely tenant-authored through Workflow Rules.
    if (record.conditions?.scenarioRouting === true
      && (!includeScenarioRules || !detectedScenario)) continue;
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
        let method = score ? 'exact' : 'none';
        if (!score && ['contains', 'any_phrase'].includes(matchMode)
          && ` ${normalizedQuery} `.includes(` ${phrase.normalized} `)) {
          score = 0.99; method = 'contains';
        }
        if (!score && matchMode !== 'exact') {
          const fuzzy = catalogLabelSimilarity(input.query, phrase.original);
          const hasEnoughEvidence = fuzzy.labelTokenCount <= 1
            || fuzzy.labelCoverage >= 0.5
            || fuzzy.queryCoverage >= 0.5;
          score = hasEnoughEvidence ? fuzzy.score : 0;
          method = score ? fuzzy.method : 'none';
        }
        const candidatePhrase = {
            matchedPhrase: phrase.original,
            score,
            method,
            tier: workflowMatchTier(method),
            specificity: workflowPhraseSpecificity(phrase.original),
          };
        if (!phraseResult
          || candidatePhrase.tier > phraseResult.tier
          || (candidatePhrase.tier === phraseResult.tier && candidatePhrase.score > phraseResult.score)
          || (candidatePhrase.tier === phraseResult.tier && candidatePhrase.score === phraseResult.score
            && candidatePhrase.specificity > phraseResult.specificity)) {
          phraseResult = candidatePhrase;
        }
      }
    } else if (normalize(record.intent) === target || normalize(record.name) === target) {
      phraseResult = {
        matchedPhrase: input.intent ?? record.intent ?? record.name,
        score: 1,
        method: 'intent',
        tier: workflowMatchTier('intent'),
        specificity: workflowPhraseSpecificity(input.intent ?? record.intent ?? record.name),
      };
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
  ranked.sort((left, right) => right.tier - left.tier
    || right.score - left.score
    || right.specificity - left.specificity
    || Number(left.record.priority ?? 100) - Number(right.record.priority ?? 100));
  const match = ranked[0];
  if (!match || match.score < confidence.clarificationConfidence) return null;
  const runnerUp = ranked.find((candidate) => candidate.record.id !== match.record.id);
  const ambiguous = Boolean(runnerUp
    && runnerUp.tier === match.tier
    && runnerUp.specificity === match.specificity
    && match.score - runnerUp.score < confidence.ambiguityMargin);
  if (!isStrongWorkflowMethod(match.method)) {
    return workflowEvidenceHint(profile, match.record, {
      matchedPhrase: match.matchedPhrase, matchMode: match.matchMode, gate: match.gate,
      confidence: Math.round(match.score * 10000) / 10000, method: match.method,
    });
  }
  if (match.score < confidence.highConfidence || ambiguous) return null;
  return withScenarioTarget(profile, match.record, workflowRecordResponse(match.record, {
    matchedPhrase: match.matchedPhrase,
    matchMode: match.matchMode,
    gate: match.gate,
    confidence: Math.round(match.score * 10000) / 10000,
    method: match.method,
  }));
}

async function semanticWorkflowRoute(auth, profile, input, runtime, currentCatalogResolution = null) {
  const configuration = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const knowledgeBases = allowedSemanticKnowledgeBases(profile);
  if (!knowledgeBases.length || !env.RAG_ENABLED || !profile.workflows.length) return null;
  const vector = await runtime.embedQueryOnce(input.query);
  const matches = await runtime.search(auth.tenantId, vector, {
    knowledgeBases,
    usageDirection: input.usageDirection,
    limit: 4,
    scoreThreshold: Math.min(env.RAG_RUNTIME_MIN_SCORE, configuration.clarificationConfidence),
    recordTypes: ['WORKFLOW_RULE'],
  });
  const allowed = new Map(knowledgeBases.map((item) => [item.id.toLowerCase(), item.publicationRevision]));
  const ranked = matches.map((match) => {
    const payload = match.payload ?? {};
    if (payload.tenant_id !== auth.tenantId.toLowerCase()
      || allowed.get(String(payload.knowledge_base_id).toLowerCase()) !== payload.publication_revision
      || ![input.usageDirection.toUpperCase(), 'BOTH'].includes(payload.agent_usage)
      || payload.record_type !== 'WORKFLOW_RULE') return null;
    const record = profile.workflows.find((item) => String(item.id).toLowerCase() === String(match.id).toLowerCase());
    if (!record) return null;
    if (record.conditions?.confidenceOutcome) return null;
    if (record.conditions?.scenarioRouting === true && input.detectedIntent?.intent !== 'scenario') return null;
    const gate = workflowStageGate(record, {
      currentStage: input.currentStage,
      selectedCatalogItemId: input.selectedCatalogItemId ?? currentCatalogResolution?.item?.id,
    });
    if (gate.reason === 'stage_transition_not_allowed') return null;
    return { record, gate, score: Number(match.score), payload };
  }).filter(Boolean).sort((left, right) => right.score - left.score
    || Number(left.record.priority ?? 100) - Number(right.record.priority ?? 100));
  const best = ranked[0];
  if (!best || best.score < configuration.clarificationConfidence) return null;
  const runnerUp = ranked[1];
  const ambiguous = Boolean(runnerUp && best.score - runnerUp.score < configuration.ambiguityMargin);
  const phrases = Array.isArray(best.record.conditions?.triggerPhrases)
    ? best.record.conditions.triggerPhrases : [];
  if (best.score < configuration.highConfidence || ambiguous) return null;
  return workflowEvidenceHint(profile, best.record, {
    matchedPhrase: phrases[0] ?? best.payload.entity_name ?? best.record.name,
    matchMode: 'semantic', gate: best.gate,
    confidence: Math.round(best.score * 10000) / 10000,
    method: 'semantic',
  });
}

export function isExactWorkflowResponse(result) {
  return result?.found === true
    && result.route === 'workflow'
    && result.workflow?.exactResponse === true
    && Boolean(String(result.content ?? '').trim());
}

function conversationRoute(profile, input) {
  if (input.routeHint !== 'conversation' && !input.flowKey && !input.nodeKey && !input.currentStage) return null;
  const flowKey = input.flowKey ?? 'main';
  const nodeKey = input.nodeKey ?? input.currentStage;
  const candidates = profile.conversations.filter((item) => item.flow_key === flowKey
    && (!nodeKey || item.node_key === nodeKey)
    && (!item.language || item.language === input.language));
  const record = candidates.find((item) => nodeKey ? item.node_key === nodeKey : item.is_entry) ?? candidates[0];
  if (!record) return null;
  return {
    ...routeResponse('conversation', record, record.content, {
      flowKey: record.flow_key, nodeKey: record.node_key,
    }),
    node: { type: record.node_type, variables: record.variables, transitions: record.transitions },
  };
}

const catalogKeywords = /\b(price|cost|rate|amount|how much|package|plan|product|service|tests?|includes?|details?)\b/iu;

function contextualCatalogClassification(profile, input, localClassification, confidence) {
  const candidateKeys = new Set((input.candidateItemKeys ?? []).map(normalize).filter(Boolean));
  const activeCategoryKey = normalize(input.activeCategoryKey);
  const selectedItemKey = normalize(input.selectedCatalogItemKey);
  const scopedItems = profile.catalog_items.filter((item) => (
    candidateKeys.has(normalize(item.item_key))
    || (selectedItemKey && normalize(item.item_key) === selectedItemKey)
    || (activeCategoryKey && normalize(item.category_key) === activeCategoryKey)
  ));
  const hasFrameContext = scopedItems.length > 0 || Boolean(
    input.currentTopic || input.pendingQuestion || input.activeCategoryName || input.selectedCatalogItemName,
  );
  if (!hasFrameContext) return null;
  // Resolve the caller's latest words inside the active Category/candidate
  // set before accepting a broader global Category match. This lets a child
  // such as "Premium male" win inside any tenant-defined parent hierarchy.
  if (scopedItems.length) {
    const scoped = classifyCatalogEntityLocally(scopedItems, input.query, confidence);
    if (scoped.status !== 'none') {
      return { classification: scoped, contextualQuery: input.query, preferScoped: true };
    }
  }
  if (localClassification.status === 'match') return null;
  const latestTokens = normalize(input.query).split(' ').filter(Boolean);
  if (localClassification.status === 'none' && latestTokens.length > 6) return null;
  const parts = [
    input.query,
    input.currentTopic,
    input.pendingQuestion,
    input.selectedCatalogItemName,
    input.activeCategoryName,
  ].map((value) => String(value ?? '').trim()).filter(Boolean);
  const seen = new Set();
  const contextualQuery = parts.filter((part) => {
    const identity = normalize(part);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).join(' ').slice(0, 1_200);
  if (!contextualQuery || normalize(contextualQuery) === normalize(input.query)) return null;
  const classification = classifyCatalogEntityLocally(
    scopedItems.length ? scopedItems : profile.catalog_items,
    contextualQuery,
    confidence,
  );
  return classification.status === 'none' ? null : { classification, contextualQuery };
}

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
      categoryKey: record.category_key, parentCategoryKey: record.parent_category_key,
      categoryDescription: record.category_description,
      categorySelectionRules: record.category_selection_rules,
      categoryAliases: record.category_aliases, aliases: record.aliases,
      relationships: record.relationships, selectionRules: record.selection_rules,
      description: record.description,
      price: record.price, currency: record.currency, attributes: record.attributes,
    },
    entityResolution: {
      method: resolution.method,
      confidence: resolution.confidence,
      matchedText: resolution.matchedText,
      matchedKind: resolution.matchedKind ?? 'name',
    },
    resolvedEntity: {
      id: record.id,
      key: record.item_key,
      name: record.name,
      category: record.category ?? record.catalog_name,
      categoryKey: record.category_key,
      parentCategoryKey: record.parent_category_key,
      canonical: true,
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
      key: resolution.categoryKey ?? records[0]?.category_key ?? null,
      parentKey: resolution.parentCategoryKey ?? records[0]?.parent_category_key ?? null,
      description: resolution.categoryDescription ?? records[0]?.category_description ?? null,
      selectionRules: resolution.categorySelectionRules ?? records[0]?.category_selection_rules ?? {},
      items: records.map((item) => ({
        id: item.id,
        key: item.item_key,
        name: item.name,
        categoryKey: item.category_key,
        parentCategoryKey: item.parent_category_key,
        categoryAliases: item.category_aliases,
        aliases: item.aliases,
        relationships: item.relationships,
        selectionRules: item.selection_rules,
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

function catalogCategoryPriceResponse(records, resolution) {
  const record = records[0];
  const category = resolution.category ?? record?.category ?? record?.catalog_name;
  const prices = records.map((item) => {
    const price = item.price == null ? null : `${item.currency ?? ''} ${item.price}`.trim();
    return price ? `${item.name} - ${price}` : item.name;
  });
  return {
    ...catalogCategoryResponse(records, resolution),
    content: `${category}: ${prices.join(', ')}`,
    categoryPriceList: true,
  };
}

function activeCatalogContextResponse(profile, input) {
  const intent = String(input.detectedIntent?.intent ?? '').toLowerCase();
  const isPriceRequest = intent === 'price';
  const isDetailsRequest = intent === 'details';
  const selectedKey = normalize(input.selectedCatalogItemKey);
  const selectedId = String(input.selectedCatalogItemId ?? '').trim();
  const selected = profile.catalog_items.find((item) => (
    (selectedId && String(item.id) === selectedId)
    || (selectedKey && normalize(item.item_key) === selectedKey)
  ));
  if (selected && (isPriceRequest || isDetailsRequest)) {
    return {
      ...catalogResponse(selected, {
        method: 'live_context', confidence: 1, matchedText: selected.name, matchedKind: 'selected_item',
      }),
      retrieval: { contextUsed: true, activeSelectionUsed: true },
    };
  }
  const categoryKey = normalize(input.activeCategoryKey);
  if (!isPriceRequest || !categoryKey) return null;
  const records = profile.catalog_items.filter((item) => normalize(item.category_key) === categoryKey)
    .sort((left, right) => Number(left.display_order ?? 0) - Number(right.display_order ?? 0));
  if (!records.length) return null;
  return {
    ...catalogCategoryPriceResponse(records, {
      category: input.activeCategoryName ?? records[0].category ?? records[0].catalog_name,
      categoryKey: records[0].category_key,
      parentCategoryKey: records[0].parent_category_key ?? null,
      method: 'live_context', confidence: 1, matchedText: input.activeCategoryName ?? records[0].category,
    }),
    retrieval: { contextUsed: true, activeCategoryUsed: true },
  };
}

async function semanticCatalogResolution(auth, profile, input, normalizedQuery, runtime, localClassification = null) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const knowledgeBases = allowedSemanticKnowledgeBases(profile);
  if (!knowledgeBases.length || !env.RAG_ENABLED) return null;
  const shortQuery = normalizedQuery.split(' ').length <= 4;
  if (input.routeHint !== 'catalog' && !catalogKeywords.test(normalizedQuery) && !shortQuery) return null;
  const fingerprint = knowledgeBases.map((item) => `${item.id}:${item.publicationRevision}`).join('|');
  const contextFingerprint = [
    input.currentTopic, input.pendingQuestion, input.activeCategoryKey, input.activeCategoryName,
    input.selectedCatalogItemKey, ...(input.candidateItemKeys ?? []),
  ].map(normalize).filter(Boolean).join('|');
  const cacheKey = `zea:rag:entity:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${hash(`${fingerprint}|${normalizedQuery}|${contextFingerprint}`)}`;
  const cached = await cacheGet(runtime.cache, cacheKey);
  if (cached) return cached;
  const vector = await runtime.embedQueryOnce(input.query);
  const rawMatches = await runtime.search(auth.tenantId, vector, {
    knowledgeBases,
    usageDirection: input.usageDirection,
    limit: contextFingerprint ? 6 : 3,
    scoreThreshold: Math.min(env.RAG_RUNTIME_MIN_SCORE, confidenceConfiguration.clarificationConfidence),
    recordTypes: ['CATALOG_ITEM'],
  });
  const allowed = new Map(knowledgeBases.map((item) => [item.id.toLowerCase(), item.publicationRevision]));
  const candidateKeys = new Set((input.candidateItemKeys ?? []).map(normalize).filter(Boolean));
  const matches = rawMatches.filter((match) => {
    const payload = match.payload ?? {};
    return payload.tenant_id === auth.tenantId.toLowerCase()
      && allowed.get(String(payload.knowledge_base_id).toLowerCase()) === payload.publication_revision
      && [input.usageDirection.toUpperCase(), 'BOTH'].includes(payload.agent_usage)
      && payload.record_type === 'CATALOG_ITEM';
  }).map((match) => {
    const metadata = match.payload?.entity_metadata ?? {};
    const itemKey = normalize(metadata.itemKey);
    const categoryKey = normalize(metadata.categoryKey);
    const categoryName = normalize(match.payload?.entity_category);
    let contextBoost = 0;
    if (normalize(input.selectedCatalogItemKey) === itemKey && itemKey) contextBoost += 0.08;
    if (candidateKeys.has(itemKey) && itemKey) contextBoost += 0.05;
    if ((normalize(input.activeCategoryKey) === categoryKey && categoryKey)
      || (normalize(input.activeCategoryName) === categoryName && categoryName)) contextBoost += 0.03;
    return { ...match, score: Math.min(1, Number(match.score) + contextBoost), contextBoost };
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
  if (sharedCategory && localClassification?.entityType !== 'item') {
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
  if (sharedCategory) {
    const resolution = {
      status: 'uncertain',
      confidence: Math.round(bestScore * 10000) / 10000,
      candidates: matches.slice(0, 3).map((match) => ({
        itemId: match.id,
        name: match.payload?.entity_name,
        confidence: Math.round(Number(match.score) * 10000) / 10000,
      })),
      reason: 'ambiguous_child_match',
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

async function catalogRoute(auth, profile, input, normalizedQuery, runtime, localClassification = null, {
  allowClarification = true,
  includeSemantic = true,
} = {}) {
  const confidence = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  let local = localClassification ?? classifyCatalogEntityLocally(profile.catalog_items, input.query, confidence);
  let contextUsed = false;
  const activeContext = activeCatalogContextResponse(profile, input);
  if (activeContext) return activeContext;
  const contextual = contextualCatalogClassification(profile, input, local, confidence);
  if (contextual && (local.status === 'none' || contextual.preferScoped)) {
    local = contextual.classification;
    contextUsed = true;
  }
  if (local.status === 'match') {
    if (local.entityType === 'category') {
      const records = [...local.items].sort((left, right) => Number(left.display_order ?? 0) - Number(right.display_order ?? 0));
      const response = records.length ? catalogCategoryResponse(records, local) : null;
      return response ? { ...response, retrieval: { contextUsed } } : null;
    }
    return { ...catalogResponse(local.item, local), retrieval: { contextUsed } };
  }
  if (!includeSemantic) {
    if (!allowClarification || local.status !== 'uncertain') return null;
    const candidateItems = local.candidates ?? [];
    const record = profile.catalog_items.find((item) => (
      String(item.id).toLowerCase() === String(candidateItems[0]?.itemId ?? '').toLowerCase()
      || item.name === candidateItems[0]?.name
    )) ?? profile.catalog_items[0];
    const response = clarificationResponse(record, confidence, candidateItems, {
      kind: 'catalog', confidence: local.confidence,
      reason: local.reason ?? (local.ambiguous ? 'ambiguous_match' : 'low_confidence'),
    });
    return response ? { ...response, retrieval: { contextUsed, semanticSkipped: true } } : null;
  }
  const semantic = await semanticCatalogResolution(auth, profile, input, normalizedQuery, runtime, local);
  const resolution = semantic?.status === 'match' ? semantic : null;
  const semanticClarificationAllowed = input.routeHint === 'catalog'
    || catalogKeywords.test(normalizedQuery)
    || local.status === 'uncertain';
  const uncertain = [
    local.status === 'uncertain' ? local : null,
    semantic?.status === 'uncertain' && semanticClarificationAllowed ? semantic : null,
  ]
    .filter(Boolean).sort((left, right) => Number(right.confidence) - Number(left.confidence))[0];
  if (!resolution) {
    if (!uncertain) return null;
    // A possible Catalog ambiguity is retained by the caller and returned only
    // after Workflow scenario routing and semantic fallback have had a chance
    // to answer the caller's complete meaning.
    if (!allowClarification) return null;
    const candidateItems = uncertain.candidates ?? [];
    const record = profile.catalog_items.find((item) => (
      String(item.id).toLowerCase() === String(candidateItems[0]?.itemId ?? '').toLowerCase()
      || item.name === candidateItems[0]?.name
      || normalize(item.category ?? item.catalog_name) === normalize(candidateItems[0]?.category ?? candidateItems[0]?.name)
    )) ?? profile.catalog_items[0];
    const response = clarificationResponse(record, confidence, candidateItems, {
      kind: 'catalog', confidence: uncertain.confidence,
      reason: uncertain.reason ?? (uncertain.ambiguous ? 'ambiguous_match' : 'low_confidence'),
    });
    return response ? { ...response, retrieval: { contextUsed } } : null;
  }
  if (resolution.entityType === 'category') {
    const categoryKey = normalize(resolution.category);
    const records = profile.catalog_items.filter((item) => (
      normalize(item.category ?? item.catalog_name) === categoryKey
    )).sort((left, right) => Number(left.display_order ?? 0) - Number(right.display_order ?? 0));
    const response = records.length ? catalogCategoryResponse(records, resolution) : null;
    return response ? { ...response, retrieval: { contextUsed } } : null;
  }
  const record = profile.catalog_items.find((item) => String(item.id).toLowerCase() === String(resolution.itemId).toLowerCase());
  return record ? { ...catalogResponse(record, resolution), retrieval: { contextUsed } } : null;
}

function faqRoute(profile, input, normalizedQuery) {
  const sameLanguage = profile.faqs.filter((item) => item.language === input.language);
  const record = sameLanguage.find((item) => normalize(item.question) === normalizedQuery)
    ?? profile.faqs.find((item) => normalize(item.question) === normalizedQuery);
  return record ? {
    ...routeResponse('faq', record, record.answer, {
      question: record.question,
      questionMatchMethod: 'exact',
    }),
    // FAQ answers are explicitly tenant-authored caller-facing speech. An
    // exact normalized question match can therefore bypass embeddings and the
    // LLM without turning fuzzy/semantic evidence into a final answer.
    directAnswer: { approved: true, matchMethod: 'exact', sourceType: 'faq' },
  } : null;
}

function lexicalRoute(profile, input, allowedRecordTypes = null) {
  const index = profile.lexical_index;
  const queryTokens = [...new Set(lexicalTokens(input.query))];
  if (!index?.documents?.length || !queryTokens.length) return null;
  const allowed = allowedRecordTypes ? new Set(allowedRecordTypes) : null;
  const documents = allowed
    ? index.documents.filter((document) => allowed.has(document.recordType))
    : index.documents;
  if (!documents.length) return null;
  const averageLength = documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length;
  const ranked = documents.map((document) => {
    const frequencies = new Map();
    for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    let matched = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (!frequency) continue;
      matched += 1;
      const documentFrequency = Number(index.documentFrequency?.[token] ?? 0);
      const inverseFrequency = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * (document.tokens.length / Math.max(1, averageLength)));
      score += inverseFrequency * ((frequency * 2.2) / denominator);
    }
    const coverage = matched / queryTokens.length;
    const confidence = matched ? Math.min(0.95, 0.5 + coverage * 0.45) : 0;
    return { document, score, matched, coverage, confidence };
  }).filter((entry) => entry.matched > 0 && entry.coverage >= (queryTokens.length > 1 ? 0.5 : 1))
    .sort((left, right) => right.coverage - left.coverage || right.score - left.score);
  if (!ranked.length) return null;
  const matches = ranked.slice(0, Math.max(3, Math.min(Number(input.topK ?? 5), 8))).map((entry) => ({
    id: entry.document.id,
    score: Math.round(entry.confidence * 10000) / 10000,
    lexicalScore: Math.round(entry.score * 10000) / 10000,
    content: entry.document.content,
    recordType: entry.document.recordType,
    knowledgeBaseId: entry.document.knowledgeBaseId,
    documentId: entry.document.documentId,
    pageNumber: entry.document.pageNumber,
  }));
  const best = matches[0];
  return {
    route: 'lexical',
    found: true,
    content: best.content,
    source: {
      recordId: best.id,
      recordType: best.recordType,
      knowledgeBaseId: best.knowledgeBaseId,
      documentId: best.documentId,
      pageNumber: best.pageNumber,
      confidence: best.score,
    },
    matches,
    lexical: { algorithm: 'bm25', cachedIndex: true },
  };
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
      && ['CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK'].includes(payload.record_type);
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

function evidenceItemContent(item) {
  const price = item.price == null ? null : `${item.currency ?? ''} ${item.price}`.trim();
  const attributes = (item.attributes ?? []).map((attribute) => (
    `${attribute.name ?? attribute.key}: ${attribute.value}`
  )).filter(Boolean);
  return [item.name, price, item.description, ...attributes].filter(Boolean).join(' - ');
}

function compactMapFromProfile(profile, knowledgeBase) {
  const belongs = (record) => record.knowledge_base_id === knowledgeBase.id;
  const records = [];
  const add = (type, record, label, summary, metadata = {}) => {
    records.push({
      id: record.id,
      type,
      documentId: record.document_id,
      documentVersionId: record.document_version_id,
      language: record.language ?? 'und',
      usageDirection: 'both',
      label: String(label ?? '').trim() || null,
      summary: String(summary ?? '').replace(/\s+/gu, ' ').trim().slice(0, 700) || null,
      metadata,
    });
  };
  for (const item of profile.catalog_items.filter(belongs)) {
    add('CATALOG_ITEM', item, item.name, evidenceItemContent(item), {
      key: item.item_key, category: item.category, categoryKey: item.category_key,
    });
  }
  for (const workflow of profile.workflows.filter(belongs)) {
    add('WORKFLOW_RULE', workflow, workflow.name, workflow.response_template, {
      intent: workflow.intent,
      responseMode: workflow.action_config?.responseMode ?? 'instruction',
      actionType: workflow.action_type,
      actionConfig: workflow.action_config,
      conditions: workflow.conditions,
    });
  }
  for (const node of profile.conversations.filter(belongs)) {
    add('CONVERSATION_NODE', node, node.node_key, node.content, {
      flowKey: node.flow_key, nodeType: node.node_type,
    });
  }
  for (const faq of profile.faqs.filter(belongs)) add('FAQ', faq, faq.question, faq.answer);
  for (const chunk of profile.general_knowledge.filter(belongs)) {
    add('KNOWLEDGE_CHUNK', chunk, chunk.source_heading, chunk.content);
  }
  return {
    version: 1,
    knowledgeBaseId: knowledgeBase.id,
    publicationRevision: knowledgeBase.publicationRevision,
    records,
  };
}

// Loads a tenant-neutral map of every assigned, published document record.
// This operation performs no keyword, alias, phonetic, fuzzy, intent, or stage
// routing; the caller's meaning is deliberately left to the grounded LLM.
export async function loadPublishedKnowledgeMap(auth, input, dependencies = defaultDependencies) {
  const startedAt = performance.now();
  const runtime = { ...defaultDependencies, ...dependencies };
  const loaded = await abortable(loadProfile(auth, input, runtime), input.abortSignal);
  if (loaded === RUNTIME_ABORTED) return { found: false, cancelled: true, maps: [], records: [] };
  const maps = [];
  for (const knowledgeBase of loaded.profile.knowledge_bases ?? []) {
    const key = knowledgeMapCacheKey(auth.tenantId, knowledgeBase.id, knowledgeBase.publicationRevision);
    let map = await cacheGet(runtime.cache, key);
    if (!map || !Array.isArray(map.records) || map.records.some((record) => !Object.hasOwn(record, 'summary'))) {
      map = compactMapFromProfile(loaded.profile, knowledgeBase);
      void cacheSet(runtime.cache, key, map, Math.max(env.RAG_RUNTIME_PROFILE_CACHE_TTL_SECONDS, 3600))
        .catch(() => undefined);
    }
    maps.push(map);
  }
  const records = maps.flatMap((map) => map.records ?? []);
  return {
    found: records.length > 0,
    route: 'published_knowledge_map',
    maps,
    records,
    knowledgeBases: loaded.profile.knowledge_bases,
    profileCacheHit: loaded.cacheHit,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

function evidenceQuery(input = {}) {
  const understanding = input.understanding ?? {};
  const entities = [
    ...(understanding.selectedEntityKeys ?? []),
    ...(understanding.selectedEntities ?? []).flatMap((item) => [item.name, item.category]),
    ...(input.knownEntities ?? []).flatMap((item) => [item.name, item.key, item.category]),
    input.activeCategoryName,
    input.selectedCatalogItemName,
    input.currentTopic,
  ];
  return [
    input.query,
    ...(Array.isArray(input.requestedFacts) ? input.requestedFacts : []),
    understanding.questionType ? `question type ${understanding.questionType}` : null,
    ...entities,
  ].map((value) => String(value ?? '').trim()).filter(Boolean).join(' ').slice(0, 2_000);
}

const publishedKnowledgeRecordTypes = Object.freeze([
  'CATALOG_ITEM', 'WORKFLOW_RULE', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK',
]);

export const searchPublishedKnowledgeOperation = Object.freeze({
  name: 'search_published_knowledge',
  description: 'Search only the current published knowledge assigned to this agent using a natural-language query.',
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false,
    properties: Object.freeze({
      semanticQuery: Object.freeze({ type: 'string', minLength: 1, maxLength: 2_000 }),
      requestedFacts: Object.freeze({
        type: 'array', maxItems: 20,
        items: Object.freeze({ type: 'string', minLength: 1, maxLength: 120 }),
      }),
    }),
    required: Object.freeze(['semanticQuery']),
  }),
});

function publishedRecordLookup(profile) {
  const records = new Map();
  const put = (recordType, record, content, extra = {}) => {
    const recordId = String(record?.id ?? '').toLowerCase();
    if (!recordId) return;
    records.set(`${recordType}:${recordId}`, {
      id: `published:${recordType.toLowerCase()}:${recordId}`,
      content: String(content ?? '').trim(), recordType, recordId,
      knowledgeBaseId: record.knowledge_base_id,
      documentId: record.document_id,
      documentVersionId: record.document_version_id,
      documentName: record.document_name,
      pageNumber: record.source_page_start ?? null,
      pageEnd: record.source_page_end ?? null,
      language: record.language ?? null,
      ...extra,
    });
  };
  for (const item of profile.catalog_items ?? []) {
    put('CATALOG_ITEM', item, evidenceItemContent(item), {
      authoritativeData: {
        itemKey: item.item_key, name: item.name,
        category: item.category ?? item.catalog_name,
        categoryKey: item.category_key, parentCategoryKey: item.parent_category_key,
        description: item.description, price: item.price, currency: item.currency,
        attributes: item.attributes ?? [], relationships: item.relationships ?? {},
        selectionRules: item.selection_rules ?? {},
      },
    });
  }
  for (const workflow of profile.workflows ?? []) {
    const responseMode = String(workflow.action_config?.responseMode ?? 'instruction').trim().toLowerCase();
    put('WORKFLOW_RULE', workflow, responseMode === 'exact' ? workflow.response_template : '', {
      callerFacing: responseMode === 'exact',
      authoritativeData: {
        name: workflow.name, intent: workflow.intent, priority: workflow.priority,
        conditions: workflow.conditions ?? {}, actionType: workflow.action_type,
        actionConfig: workflow.action_config ?? {}, responseMode,
      },
    });
  }
  for (const node of profile.conversations ?? []) {
    put('CONVERSATION_NODE', node, node.content, {
      callerFacing: String(node.node_type ?? '').toLowerCase() !== 'guidance',
      authoritativeData: {
        flowKey: node.flow_key, nodeKey: node.node_key, nodeType: node.node_type,
        variables: node.variables ?? [], transitions: node.transitions ?? [],
      },
    });
  }
  for (const faq of profile.faqs ?? []) {
    put('FAQ', faq, faq.answer, {
      authoritativeData: { question: faq.question, answer: faq.answer },
    });
  }
  for (const chunk of profile.general_knowledge ?? []) {
    put('KNOWLEDGE_CHUNK', chunk, chunk.content, {
      authoritativeData: { heading: chunk.source_heading ?? null, content: chunk.content },
    });
  }
  return records;
}

function publishedSearchCacheKey(auth, input, knowledgeBases) {
  const revisions = knowledgeBases
    .map((item) => `${String(item.id).toLowerCase()}:${item.publicationRevision}`)
    .sort().join('|');
  return `zea:rag:published-search:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${hash(JSON.stringify({
    revisions, query: evidenceQuery(input), requestedFacts: input.requestedFacts ?? [],
    language: input.language ?? 'und', selectedCatalogItemKey: input.selectedCatalogItemKey ?? null,
    activeCategoryName: input.activeCategoryName ?? null,
  }))}`;
}

// Generic internal operation. The input contains no SQL or provider details.
// Qdrant discovers IDs; exact evidence is hydrated from the current approved
// PostgreSQL profile (or its short-lived, revision-scoped cache).
export async function searchPublishedKnowledge(auth, input, dependencies = defaultDependencies) {
  const startedAt = performance.now();
  const runtime = { ...defaultDependencies, ...dependencies };
  const semanticQuery = String(input.semanticQuery ?? input.query ?? '').trim().slice(0, 2_000);
  const safeInput = {
    ...input,
    query: semanticQuery,
    requestedFacts: Array.isArray(input.requestedFacts)
      ? input.requestedFacts.map((value) => String(value).trim().slice(0, 120)).filter(Boolean).slice(0, 20)
      : [],
  };
  const loaded = await abortable(
    withinDeadline(loadProfile(auth, safeInput, runtime), env.RAG_RUNTIME_CHANNEL_DEADLINE_MS),
    input.abortSignal,
  );
  if (loaded === RUNTIME_ABORTED) {
    return {
      operation: 'search_published_knowledge', found: false, sources: [], actionEvidence: [], guidanceEvidence: [],
      entities: [], cancelled: true,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
  if (loaded === RUNTIME_TIMED_OUT) {
    return {
      operation: 'search_published_knowledge', found: false, sources: [], actionEvidence: [], guidanceEvidence: [],
      entities: [], timedOut: true, timedOutStage: 'postgres_hydration',
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
  const { profile } = loaded;
  const knowledgeBases = allowedSemanticKnowledgeBases(profile);
  const cacheKey = publishedSearchCacheKey(auth, safeInput, knowledgeBases);
  const cached = await cacheGet(runtime.cache, cacheKey);
  if (cached) return { ...cached, cacheHit: true };

  const lookup = publishedRecordLookup(profile);
  const sources = [];
  const actionEvidence = [];
  const guidanceEvidence = [];
  const entities = [];
  const selectedKeys = new Set([
    ...(safeInput.understanding?.selectedEntityKeys ?? []),
    ...(safeInput.understanding?.selectedEntities ?? []).map((item) => item.key),
    ...(safeInput.knownEntities ?? []).map((item) => item.key),
    safeInput.selectedCatalogItemKey,
  ].map(normalize).filter(Boolean));
  for (const item of profile.catalog_items ?? []) {
    if (!selectedKeys.has(normalize(item.item_key))) continue;
    const source = lookup.get(`CATALOG_ITEM:${String(item.id).toLowerCase()}`);
    if (source?.content) sources.push({ ...source, score: 1, matchMode: 'live_context' });
    entities.push({
      id: item.id, key: item.item_key, name: item.name,
      category: item.category ?? item.catalog_name, categoryKey: item.category_key,
      parentCategoryKey: item.parent_category_key,
    });
  }

  if (knowledgeBases.length && runtime.ragEnabled && semanticQuery) {
    const semanticResult = await abortable(
      timed((async () => {
        const vector = await runtime.embed(evidenceQuery(safeInput), { signal: input.abortSignal });
        return runtime.search(auth.tenantId, vector, {
          knowledgeBases, usageDirection: safeInput.usageDirection, agentId: safeInput.agentId,
          abortSignal: input.abortSignal,
          limit: Math.max(4, Math.min(Number(safeInput.topK ?? 8), 10)),
          scoreThreshold: env.RAG_RUNTIME_MIN_SCORE,
          recordTypes: publishedKnowledgeRecordTypes,
        });
      })(), env.RAG_RUNTIME_SEMANTIC_DEADLINE_MS),
      input.abortSignal,
    );
    if (semanticResult === RUNTIME_ABORTED) {
      return {
        operation: 'search_published_knowledge', found: false, sources: [], actionEvidence: [], guidanceEvidence: [],
        entities: [], cancelled: true,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
    }
    const rawMatches = semanticResult ?? [];
    const allowed = new Map(knowledgeBases.map((item) => [String(item.id).toLowerCase(), item.publicationRevision]));
    for (const match of rawMatches) {
      const payload = match.payload ?? {};
      const recordType = String(payload.record_type ?? '').toUpperCase();
      const recordId = String(payload.record_id ?? match.id ?? '').toLowerCase();
      const knowledgeBaseId = String(payload.knowledge_base_id ?? '').toLowerCase();
      const assignedAgentIds = Array.isArray(payload.assigned_agent_ids)
        ? payload.assigned_agent_ids.map((id) => String(id).toLowerCase()) : [];
      if (String(payload.tenant_id ?? '').toLowerCase() !== auth.tenantId.toLowerCase()
        || allowed.get(knowledgeBaseId) !== Number(payload.publication_revision)
        || ![String(safeInput.usageDirection).toUpperCase(), 'BOTH'].includes(payload.agent_usage)
        || (assignedAgentIds.length && !assignedAgentIds.includes(String(safeInput.agentId).toLowerCase()))
        || !publishedKnowledgeRecordTypes.includes(recordType)) continue;
      const hydrated = lookup.get(`${recordType}:${recordId}`);
      if (!hydrated || String(hydrated.knowledgeBaseId).toLowerCase() !== knowledgeBaseId) continue;
      const evidence = { ...hydrated, score: Number(match.score), matchMode: 'semantic' };
      if (recordType === 'WORKFLOW_RULE' && evidence.callerFacing !== true) {
        actionEvidence.push(evidence);
        continue;
      }
      if (recordType === 'CONVERSATION_NODE' && evidence.callerFacing !== true) {
        guidanceEvidence.push(evidence);
        continue;
      }
      if (!evidence.content) continue;
      if (!sources.some((source) => `${source.recordType}:${source.recordId}` === `${recordType}:${recordId}`)) {
        sources.push(evidence);
      }
      if (recordType === 'CATALOG_ITEM') {
        const data = evidence.authoritativeData ?? {};
        if (data.itemKey && data.name && !entities.some((item) => normalize(item.key) === normalize(data.itemKey))) {
          entities.push({
            id: recordId, key: data.itemKey, name: data.name,
            category: data.category ?? null, categoryKey: data.categoryKey ?? null,
            parentCategoryKey: data.parentCategoryKey ?? null,
          });
        }
      }
    }
  }
  const result = {
    operation: 'search_published_knowledge',
    found: sources.length > 0 || actionEvidence.length > 0 || guidanceEvidence.length > 0,
    route: 'tenant_evidence', sources, actionEvidence, guidanceEvidence, entities,
    requestedFacts: safeInput.requestedFacts,
    publicationRevisions: knowledgeBases.map((item) => ({
      knowledgeBaseId: item.id, publicationRevision: item.publicationRevision,
    })),
    profileCacheHit: loaded.cacheHit,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  void cacheSet(runtime.cache, cacheKey, result, env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS)
    .catch(() => undefined);
  return result;
}

// Compatibility name used by the orchestrator; all live retrieval now goes
// through the single generic, PostgreSQL-hydrated operation.
export async function retrieveTenantEvidence(auth, input, dependencies = defaultDependencies) {
  return searchPublishedKnowledge(auth, input, dependencies);
}

async function parallelKnowledgeCandidates({
  auth, profile, input, normalizedQuery, runtime, currentCatalogClassification, currentCatalogResolution,
}) {
  const automatic = input.routeHint === 'auto';
  const workflow = automatic || input.routeHint === 'workflow';
  const catalog = automatic || input.routeHint === 'catalog';
  const conversation = automatic || input.routeHint === 'conversation';
  const faq = automatic || input.routeHint === 'faq';
  const semantic = automatic || input.routeHint === 'semantic';
  const semanticDeadlineMs = env.RAG_RUNTIME_SEMANTIC_DEADLINE_MS;
  return runParallelHybridRetrieval({
    ...(workflow ? {
      workflow_strong: () => {
        const candidate = workflowRoute(
          profile, input, normalizedQuery, currentCatalogResolution, { includeScenarioRules: false },
        );
        return candidate?.route === 'workflow' ? candidate : null;
      },
      workflow_fuzzy_phonetic: () => {
        const candidate = workflowRoute(
          profile, input, normalizedQuery, currentCatalogResolution, { includeScenarioRules: false },
        );
        return candidate?.route === 'workflow_hint' ? candidate : null;
      },
    } : {}),
    ...(workflow && input.detectedIntent?.intent === 'scenario' ? {
      workflow_scenario: () => workflowRoute(
        profile, input, normalizedQuery, currentCatalogResolution, { includeScenarioRules: true },
      ),
    } : {}),
    ...(catalog ? {
      live_state_context: () => activeCatalogContextResponse(profile, input),
      catalog_alias_hierarchy: async () => {
        const candidate = await catalogRoute(
          auth, profile, input, normalizedQuery, runtime, currentCatalogClassification,
          { allowClarification: false, includeSemantic: false },
        );
        return ['fuzzy', 'phonetic'].includes(candidate?.entityResolution?.method) ? null : candidate;
      },
      catalog_fuzzy_phonetic: async () => {
        const candidate = await catalogRoute(
          auth, profile, input, normalizedQuery, runtime, currentCatalogClassification,
          { allowClarification: false, includeSemantic: false },
        );
        return ['fuzzy', 'phonetic'].includes(candidate?.entityResolution?.method) ? candidate : null;
      },
    } : {}),
    // Catalog and Workflow have dedicated alias/fuzzy resolvers; the BM25
    // channel searches caller-facing document indexes so it cannot collapse
    // an ambiguous entity set into an arbitrary Catalog item.
    lexical_bm25: () => lexicalRoute(
      profile, input, ['CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK'],
    ),
    ...(conversation ? {
      conversation_script: () => lexicalRoute(profile, input, ['CONVERSATION_NODE']),
      stage_continuation: () => conversationRoute(profile, input),
    } : {}),
    ...(faq ? {
      faq_exact: () => faqRoute(profile, input, normalizedQuery),
      faq_search: () => lexicalRoute(profile, input, ['FAQ']),
    } : {}),
    general_knowledge: () => lexicalRoute(profile, input, ['KNOWLEDGE_CHUNK']),
    ...(semantic ? {
      workflow_semantic: {
        deadlineMs: semanticDeadlineMs,
        retrieve: () => semanticWorkflowRoute(auth, profile, input, runtime, currentCatalogResolution),
      },
      catalog_semantic: {
        deadlineMs: semanticDeadlineMs,
        retrieve: () => catalogRoute(
          auth, profile, input, normalizedQuery, runtime, currentCatalogClassification,
          { allowClarification: false, includeSemantic: true },
        ),
      },
      document_semantic: {
        deadlineMs: semanticDeadlineMs,
        retrieve: () => semanticRoute(auth, profile, input, normalizedQuery, runtime),
      },
    } : {}),
  }, {
    defaultDeadlineMs: env.RAG_RUNTIME_CHANNEL_DEADLINE_MS,
    signal: input.abortSignal,
  });
}

async function parallelRankedKnowledgeResult({
  auth, profile, input, normalizedQuery, runtime, confidence,
  currentCatalogClassification, currentCatalogResolution, currentCatalogEntities,
}) {
  const retrieval = await parallelKnowledgeCandidates({
    auth, profile, input, normalizedQuery, runtime,
    currentCatalogClassification, currentCatalogResolution,
  });
  const uniqueCandidates = [...new Map(retrieval.candidates.map((candidate) => [
    [candidate.route, candidate.source?.recordId, candidate.content].map(String).join('|'), candidate,
  ])).values()];
  const clarifications = uniqueCandidates.filter((candidate) => candidate.route === 'clarification');
  const workflowHints = uniqueCandidates.filter((candidate) => candidate.route === 'workflow_hint');
  const rankingStartedAt = performance.now();
  const ranked = rankHybridEvidence(
    uniqueCandidates.filter((candidate) => candidate.route !== 'clarification'),
    {
      selectedItemId: input.selectedCatalogItemId,
      selectedItemKey: input.selectedCatalogItemKey,
      resolvedEntityId: currentCatalogResolution?.item?.id,
      resolvedEntityKey: currentCatalogResolution?.item?.item_key,
      activeCategoryKey: input.activeCategoryKey,
      questionType: input.detectedIntent?.intent,
      pendingQuestionType: input.pendingQuestionType,
      currentStage: input.currentStage,
      knowledgeBases: profile.knowledge_bases,
    },
  );
  // A Conversation Script node represents where the call can continue; it is
  // not evidence that it answers the caller's latest question. Prefer every
  // grounded question candidate before falling back to the saved stage node.
  const questionRanked = ranked.filter((entry) => entry.candidate.route !== 'conversation');
  const selectedCandidate = questionRanked[0]?.candidate
    ?? ranked[0]?.candidate
    ?? clarifications[0]
    ?? null;
  const confidenceRoute = resolveEvidenceConfidence(questionRanked.length ? questionRanked : ranked, confidence);
  const configuredConfidenceRule = profile.workflows
    .filter((record) => record.conditions?.confidenceOutcome === confidenceRoute.outcome)
    .sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100))
    .find((record) => workflowStageGate(record, {
      currentStage: input.currentStage,
      selectedCatalogItemId: input.selectedCatalogItemId,
    }).allowed !== false);
  const configuredConfidenceResponse = configuredConfidenceRule
    ? workflowRecordResponse(configuredConfidenceRule, {
      matchedPhrase: confidenceRoute.outcome,
      matchMode: 'confidence_outcome',
      gate: workflowStageGate(configuredConfidenceRule, {
        currentStage: input.currentStage,
        selectedCatalogItemId: input.selectedCatalogItemId,
      }),
      confidence: confidenceRoute.confidence,
      method: 'confidence_outcome',
    }) : null;
  let result = confidenceRoute.outcome === 'high'
    ? (selectedCandidate ? { ...selectedCandidate } : null)
    : (configuredConfidenceResponse ? { ...configuredConfidenceResponse } : null);
  const catalogAllowed = input.routeHint === 'auto' || input.routeHint === 'catalog';
  if (!result && catalogAllowed) {
    result = await catalogRoute(auth, profile, input, normalizedQuery, runtime, currentCatalogClassification, {
      allowClarification: true,
      includeSemantic: false,
    });
  }
  // Ambiguous evidence is still useful grounding for the single LLM call.
  // It must not become direct speech, but dropping it entirely causes an
  // unnecessary no-evidence response when approved documents were retrieved.
  if (!result && selectedCandidate) result = { ...selectedCandidate };
  if (['workflow', 'workflow_hint'].includes(result?.route) && currentCatalogEntities.length > 1) {
    result.catalogSelections = currentCatalogEntities.map((selection) => catalogResponse(selection.item, selection));
  } else if (['workflow', 'workflow_hint'].includes(result?.route) && currentCatalogResolution?.entityType === 'item') {
    result.catalogSelection = catalogResponse(currentCatalogResolution.item, currentCatalogResolution);
  }
  if (!result) return null;
  const orderedEvidence = [
    ...questionRanked,
    ...ranked.filter((entry) => entry.candidate.route === 'conversation'),
  ];
  result.rankedEvidence = rankedEvidenceBundle(orderedEvidence);
  result.retrieval = {
    ...(result.retrieval ?? {}),
    parallelDurationMs: retrieval.durationMs,
    channelsStarted: retrieval.channelsStarted,
    channelFailures: retrieval.failures,
    candidateCount: uniqueCandidates.length,
    confidence: confidence.highConfidence,
    semanticDeadlineMs: env.RAG_RUNTIME_SEMANTIC_DEADLINE_MS,
    usedCachedDocumentIndex: profile.lexical_index?.version === 1,
  };
  result.confidenceRouting = confidenceRoute;
  result.questionType = input.detectedIntent?.intent ?? 'unclear';
  const directValidation = validateDirectAnswer(result, {
    questionType: input.detectedIntent?.intent,
    confidenceOutcome: confidenceRoute.outcome,
  });
  if (result.directAnswer?.approved === true) {
    result.directAnswer = { ...result.directAnswer, validated: directValidation.valid };
  }
  result.directAnswerValidation = directValidation;
  result.rankingValidationDurationMs = Math.round((performance.now() - rankingStartedAt) * 100) / 100;
  if (workflowHints.length) result.workflowHints = workflowHints;
  return result;
}

export async function routeKnowledgeQuery(auth, input, dependencies = defaultDependencies) {
  // Deprecated compatibility entry point. Keyword, fuzzy and stage routing is
  // permanently bypassed; every caller now receives the generic published-
  // knowledge search result hydrated from PostgreSQL.
  return searchPublishedKnowledge(auth, {
    agentId: input.agentId,
    query: input.query,
    requestedFacts: input.requestedFacts ?? [],
    usageDirection: input.usageDirection,
    language: input.language,
    currentTopic: input.currentTopic,
    knownEntities: input.knownEntities ?? [],
    pendingQuestion: input.pendingQuestion,
    topK: input.topK,
    abortSignal: input.abortSignal,
  }, dependencies);
  /* c8 ignore start -- unreachable compatibility implementation
  const startedAt = performance.now();
  if (input.abortSignal?.aborted) {
    return { route: 'none', found: false, content: null, source: null, cancelled: true, durationMs: 0 };
  }
  const runtime = { ...defaultDependencies, ...dependencies };
  let queryVectorPromise = null;
  runtime.embedQueryOnce = (query) => {
    queryVectorPromise ??= runtime.embed(query);
    return queryVectorPromise;
  };
  const normalizedQuery = normalize(input.query);
  const loaded = await loadProfile(auth, input, runtime);
  const { profile } = loaded;
  const routingStartedAt = performance.now();
  const confidence = resolveKnowledgeConfidenceConfiguration(profile.agent_settings);
  const currentCatalogClassification = classifyCatalogEntityLocally(profile.catalog_items, input.query, confidence);
  const currentCatalogResolution = currentCatalogClassification.status === 'match'
    ? currentCatalogClassification : null;
  const currentCatalogEntities = resolveCatalogEntitiesLocally(profile.catalog_items, input.query, {
    minimumConfidence: confidence.highConfidence,
  });

  // Question-first fast path. Strong tenant-configured Workflow matches are
  // evaluated before any embedding/Qdrant work. Exact FAQ questions are also
  // safe to speak directly because their answers are approved caller-facing
  // document content. Stage-gated actions retain their safety gate; ordinary
  // current-stage script wording is deliberately not considered here.
  const fastWorkflow = (input.routeHint === 'auto' || input.routeHint === 'workflow')
    ? workflowRoute(profile, input, normalizedQuery, currentCatalogResolution, {
      includeScenarioRules: input.detectedIntent?.intent === 'scenario',
    })
    : null;
  let fastResult = fastWorkflow?.route === 'workflow' ? fastWorkflow : null;
  if (!fastResult && (input.routeHint === 'auto' || input.routeHint === 'faq')) {
    fastResult = faqRoute(profile, input, normalizedQuery);
  }
  if (fastResult?.directAnswer?.approved === true
    || (fastResult?.route === 'workflow' && fastResult.workflow?.deterministic === true)) {
    if (fastResult.route === 'workflow' && currentCatalogEntities.length > 1) {
      fastResult.catalogSelections = currentCatalogEntities.map((selection) => catalogResponse(selection.item, selection));
    } else if (fastResult.route === 'workflow' && currentCatalogResolution?.entityType === 'item') {
      fastResult.catalogSelection = catalogResponse(currentCatalogResolution.item, currentCatalogResolution);
    }
    return {
      ...fastResult,
      directAnswer: fastResult.directAnswer
        ? { ...fastResult.directAnswer, validated: true }
        : fastResult.directAnswer,
      questionType: input.detectedIntent?.intent ?? 'unclear',
      profileCacheHit: loaded.cacheHit,
      fastPath: {
        type: fastResult.route === 'workflow' ? 'deterministic_workflow' : 'exact_faq',
        skippedEmbedding: true,
        skippedLlm: true,
        routingDurationMs: Math.round((performance.now() - routingStartedAt) * 100) / 100,
      },
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
  // Concurrent hybrid retrieval is the SaaS default for every tenant. An
  // explicit false remains available only as a temporary legacy rollback.
  if (profile.agent_settings?.parallelHybridRetrievalEnabled !== false) {
    const knowledgeFingerprint = profile.knowledge_bases
      .map((item) => `${item.id}:${item.publicationRevision}`).join('|');
    const hybridContext = [
      input.detectedIntent?.intent, input.currentStage, input.activeCategoryKey,
      input.selectedCatalogItemId, input.selectedCatalogItemKey, input.pendingQuestionType,
    ].map((value) => normalize(value)).join('|');
    const hybridCacheKey = `zea:rag:hybrid:${auth.tenantId}:${input.agentId}:${input.usageDirection}:${hash(
      `${knowledgeFingerprint}|${normalizedQuery}|${hybridContext}`,
    )}`;
    const cachedHybrid = await cacheGet(runtime.cache, hybridCacheKey);
    if (cachedHybrid) {
      return {
        ...cachedHybrid,
        profileCacheHit: loaded.cacheHit,
        hybridCacheHit: true,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
    }
    const parallelResult = await parallelRankedKnowledgeResult({
      auth, profile, input, normalizedQuery, runtime, confidence,
      currentCatalogClassification, currentCatalogResolution, currentCatalogEntities,
    });
    const response = {
      ...(parallelResult ?? { route: 'none', found: false, content: null, source: null }),
      profileCacheHit: loaded.cacheHit,
      hybridCacheHit: false,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
    if (response.found === true && response.route !== 'workflow' && !input.abortSignal?.aborted) {
      void cacheSet(runtime.cache, hybridCacheKey, response, env.RAG_RUNTIME_RESULT_CACHE_TTL_SECONDS)
        .catch(() => undefined);
    }
  return response;
}
  const hasMultipleCatalogItems = currentCatalogEntities.length > 1;
  let result = null;

  const automaticRoute = input.routeHint === 'auto';
  const workflowRouteAllowed = automaticRoute || input.routeHint === 'workflow';
  const catalogRouteAllowed = automaticRoute || input.routeHint === 'catalog';
  let deferredClarification = null;
  const workflowHints = [];
  const retainWorkflowHint = (candidate) => {
    if (candidate?.route === 'workflow_hint') workflowHints.push(candidate);
  };

  // Routing order is intentionally strict. A weak fuzzy Workflow result must
  // never hide the active topic, a Catalog entity, or an approved scenario.
  // Clarification is retained until every grounded deterministic route fails.
  if (workflowRouteAllowed) {
    const exactWorkflow = workflowRoute(profile, input, normalizedQuery, currentCatalogResolution, {
      includeScenarioRules: false,
    });
    if (exactWorkflow?.route === 'workflow') result = exactWorkflow;
    else if (exactWorkflow?.route === 'clarification') deferredClarification = exactWorkflow;
    else retainWorkflowHint(exactWorkflow);
  }

  if (!result && catalogRouteAllowed) {
    result = await catalogRoute(
      auth, profile, input, normalizedQuery, runtime, currentCatalogClassification,
      { allowClarification: false },
    );
  }

  if (!result && workflowRouteAllowed && input.detectedIntent?.intent === 'scenario') {
    const scenarioWorkflow = workflowRoute(profile, input, normalizedQuery, currentCatalogResolution, {
      includeScenarioRules: true,
    });
    if (scenarioWorkflow?.route === 'workflow') result = scenarioWorkflow;
    else if (scenarioWorkflow?.route === 'clarification') deferredClarification ??= scenarioWorkflow;
    else retainWorkflowHint(scenarioWorkflow);
  }

  if (!result && workflowRouteAllowed) {
    const semanticWorkflow = await semanticWorkflowRoute(
      auth, profile, input, runtime, currentCatalogResolution,
    );
    if (semanticWorkflow?.route === 'workflow') result = semanticWorkflow;
    else if (semanticWorkflow?.route === 'clarification') deferredClarification ??= semanticWorkflow;
    else if (semanticWorkflow?.route === 'workflow_hint') result = semanticWorkflow;
  }

  if (result?.route === 'clarification' && currentCatalogResolution && !hasMultipleCatalogItems) {
    result = currentCatalogResolution.entityType === 'category'
      ? catalogCategoryResponse(
        [...currentCatalogResolution.items]
          .sort((left, right) => Number(left.display_order ?? 0) - Number(right.display_order ?? 0)),
        currentCatalogResolution,
      )
      : catalogResponse(currentCatalogResolution.item, currentCatalogResolution);
  }
  if (['workflow', 'workflow_hint'].includes(result?.route) && hasMultipleCatalogItems) {
    result.catalogSelections = currentCatalogEntities.map((selection) => (
      catalogResponse(selection.item, selection)
    ));
  } else if (['workflow', 'workflow_hint'].includes(result?.route) && currentCatalogResolution?.entityType === 'item') {
    result.catalogSelection = catalogResponse(currentCatalogResolution.item, currentCatalogResolution);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'catalog')) {
    result = await catalogRoute(
      auth, profile, input, normalizedQuery, runtime, currentCatalogClassification,
      { allowClarification: false },
    );
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'faq')) {
    result = faqRoute(profile, input, normalizedQuery);
  }
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'semantic')) {
    result = await semanticRoute(auth, profile, input, normalizedQuery, runtime);
  }
  // The saved stage is continuation context, not an answer gate. Consult its
  // Script node only after routes that can answer the latest caller question.
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'conversation')) {
    result = conversationRoute(profile, input);
  }
  // Clarification is deliberately last. At this point the exact rules, live
  // frame, Catalog hierarchy, scenario rules and semantic evidence have all
  // failed to produce an approved answer.
  if (!result && deferredClarification) result = deferredClarification;
  if (!result && catalogRouteAllowed) {
    result = await catalogRoute(auth, profile, input, normalizedQuery, runtime, currentCatalogClassification, {
      allowClarification: true,
    });
  }

  if (result && workflowHints.length) result.workflowHints = workflowHints;

  return {
    ...(result ?? { route: 'none', found: false, content: null, source: null }),
    profileCacheHit: loaded.cacheHit,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}
  c8 ignore stop */
}

async function invalidateTenantKnowledgeCacheInternal(tenantId, cache, includeKnowledgeMaps) {
  const tenant = requireTenantId(tenantId);
  if (!cache || (cache.status && cache.status !== 'ready')) {
    return { deletedKeys: 0, incomplete: true };
  }
  let deletedKeys = 0;
  const patterns = [
    `zea:rag:profile:${tenant}:*`,
    `zea:rag:result:${tenant}:*`,
    `zea:rag:published-search:${tenant}:*`,
    `zea:rag:entity:${tenant}:*`,
    `zea:rag:hybrid:${tenant}:*`,
    ...(includeKnowledgeMaps ? [`zea:rag:knowledge-map:${tenant}:*`] : []),
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

export function invalidateTenantKnowledgeCache(tenantId, cache = redis) {
  return invalidateTenantKnowledgeCacheInternal(tenantId, cache, true);
}

export function invalidateTenantRuntimeKnowledgeCache(tenantId, cache = redis) {
  return invalidateTenantKnowledgeCacheInternal(tenantId, cache, false);
}
