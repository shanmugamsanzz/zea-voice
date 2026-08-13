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
import { rankHybridEvidence, rankedEvidenceBundle, resolveEvidenceConfidence } from './hybrid-evidence-ranker.js';
import { runParallelHybridRetrieval } from './parallel-hybrid-retrieval.js';

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

function evidenceQuery(input = {}) {
  const understanding = input.understanding ?? {};
  const entities = [
    ...(understanding.selectedEntityKeys ?? []),
    ...(understanding.selectedEntities ?? []).flatMap((item) => [item.name, item.category]),
    input.activeCategoryName,
    input.selectedCatalogItemName,
  ];
  return [
    input.query,
    understanding.questionType ? `question type ${understanding.questionType}` : null,
    ...entities,
  ].map((value) => String(value ?? '').trim()).filter(Boolean).join(' ').slice(0, 2_000);
}

// This is deliberately evidence retrieval rather than another routing path.
// The first grounded LLM decision describes the caller's natural question;
// this function uses that neutral decision to collect tenant-approved support
// from every published source type. No company names, entities or question
// phrases are encoded here.
export async function retrieveTenantEvidence(auth, input, dependencies = defaultDependencies) {
  const startedAt = performance.now();
  const runtime = { ...defaultDependencies, ...dependencies };
  const loaded = await loadProfile(auth, input, runtime);
  const { profile } = loaded;
  const knowledgeBases = allowedSemanticKnowledgeBases(profile);
  const selectedKeys = new Set([
    ...(input.understanding?.selectedEntityKeys ?? []),
    ...(input.understanding?.selectedEntities ?? []).map((item) => item.key),
    input.selectedCatalogItemKey,
  ].map(normalize).filter(Boolean));
  const directItems = profile.catalog_items.filter((item) => selectedKeys.has(normalize(item.item_key)));
  const sources = directItems.map((item) => ({
    id: `catalog:${item.id}`,
    content: evidenceItemContent(item),
    recordType: 'CATALOG_ITEM',
    recordId: item.id,
    knowledgeBaseId: item.knowledge_base_id,
    documentId: item.document_id,
    pageNumber: item.source_page_start ?? null,
  })).filter((source) => source.content);
  const entities = directItems.map((item) => ({
    id: item.id, key: item.item_key, name: item.name,
    category: item.category ?? item.catalog_name, categoryKey: item.category_key,
    parentCategoryKey: item.parent_category_key,
  }));
  const understandingKeys = new Set([
    input.understanding?.intent,
    input.understanding?.questionType,
  ].map(normalize).filter(Boolean));
  for (const workflow of profile.workflows) {
    if (!understandingKeys.has(normalize(workflow.intent)) && !understandingKeys.has(normalize(workflow.name))) continue;
    const responseMode = String(workflow.action_config?.responseMode ?? 'instruction').trim().toLowerCase();
    // Instruction-mode Workflow text is runtime metadata, never LLM evidence
    // and never caller-facing speech.
    if (responseMode === 'instruction') continue;
    const content = String(workflow.response_template ?? '').trim();
    if (!content) continue;
    sources.push({
      id: `workflow:${workflow.id}`, content, recordType: 'WORKFLOW_RULE', recordId: workflow.id,
      knowledgeBaseId: workflow.knowledge_base_id, documentId: workflow.document_id,
      pageNumber: workflow.source_page_start ?? null,
    });
  }
  for (const node of profile.conversations) {
    if (String(node.node_key ?? '') !== String(input.currentStage ?? '')) continue;
    const content = String(node.content ?? '').trim();
    if (!content) continue;
    sources.push({
      id: `conversation:${node.id}`, content, recordType: 'CONVERSATION_NODE', recordId: node.id,
      knowledgeBaseId: node.knowledge_base_id, documentId: node.document_id,
      pageNumber: node.source_page_start ?? null,
    });
  }
  if (knowledgeBases.length && env.RAG_ENABLED) {
    const query = evidenceQuery(input);
    const vector = await runtime.embed(query);
    const rawMatches = await runtime.search(auth.tenantId, vector, {
      knowledgeBases,
      usageDirection: input.usageDirection,
      limit: Math.max(4, Math.min(Number(input.topK ?? 8), 12)),
      scoreThreshold: env.RAG_RUNTIME_MIN_SCORE,
      recordTypes: ['CATALOG_ITEM', 'WORKFLOW_RULE', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK'],
    });
    const allowed = new Map(knowledgeBases.map((item) => [item.id.toLowerCase(), item.publicationRevision]));
    for (const match of rawMatches) {
      const payload = match.payload ?? {};
      const recordType = String(payload.record_type ?? '').toUpperCase();
      if (payload.tenant_id !== auth.tenantId.toLowerCase()
        || allowed.get(String(payload.knowledge_base_id).toLowerCase()) !== payload.publication_revision
        || ![input.usageDirection.toUpperCase(), 'BOTH'].includes(payload.agent_usage)
        || !['CATALOG_ITEM', 'WORKFLOW_RULE', 'CONVERSATION_NODE', 'FAQ', 'KNOWLEDGE_CHUNK'].includes(recordType)) continue;
      // Semantic Workflow points can contain instruction metadata. Exact
      // Workflow routing already evaluates these safely, so do not expose raw
      // vector Workflow text as evidence for caller speech.
      if (recordType === 'WORKFLOW_RULE') continue;
      const content = String(payload.answer ?? payload.content ?? '').trim();
      if (!content) continue;
      const identity = `${recordType}:${match.id}`;
      if (sources.some((source) => `${source.recordType}:${source.recordId}` === identity)) continue;
      sources.push({
        id: `retrieved:${match.id}`,
        content,
        recordType,
        recordId: match.id,
        knowledgeBaseId: payload.knowledge_base_id,
        documentId: payload.document_id,
        pageNumber: payload.page_number ?? null,
        score: Number(match.score),
      });
      const metadata = payload.entity_metadata ?? {};
      const key = String(metadata.itemKey ?? '').trim();
      const name = String(payload.entity_name ?? '').trim();
      if (key && name && !entities.some((item) => normalize(item.key) === normalize(key))) {
        entities.push({ key, name, category: payload.entity_category ?? null, categoryKey: metadata.categoryKey ?? null });
      }
    }
  }
  return {
    found: sources.length > 0,
    route: 'tenant_evidence',
    sources,
    entities,
    profileCacheHit: loaded.cacheHit,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
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
  return runParallelHybridRetrieval({
    ...(workflow ? {
      workflow_exact: () => workflowRoute(
        profile, input, normalizedQuery, currentCatalogResolution, { includeScenarioRules: false },
      ),
      workflow_semantic: () => semanticWorkflowRoute(auth, profile, input, runtime, currentCatalogResolution),
    } : {}),
    ...(workflow && input.detectedIntent?.intent === 'scenario' ? {
      workflow_scenario: () => workflowRoute(
        profile, input, normalizedQuery, currentCatalogResolution, { includeScenarioRules: true },
      ),
    } : {}),
    ...(catalog ? {
      catalog_hybrid: () => catalogRoute(
        auth, profile, input, normalizedQuery, runtime, currentCatalogClassification,
        { allowClarification: false },
      ),
    } : {}),
    ...(conversation ? { conversation_script: () => conversationRoute(profile, input) } : {}),
    ...(faq ? { faq_exact: () => faqRoute(profile, input, normalizedQuery) } : {}),
    ...(semantic ? { document_semantic: () => semanticRoute(auth, profile, input, normalizedQuery, runtime) } : {}),
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
  const ranked = rankHybridEvidence(
    uniqueCandidates.filter((candidate) => candidate.route !== 'clarification'),
    {
      selectedItemId: input.selectedCatalogItemId,
      selectedItemKey: input.selectedCatalogItemKey,
      activeCategoryKey: input.activeCategoryKey,
      currentStage: input.currentStage,
      knowledgeBases: profile.knowledge_bases,
    },
  );
  const selectedCandidate = ranked[0]?.candidate ?? clarifications[0] ?? null;
  const confidenceRoute = resolveEvidenceConfidence(ranked, confidence);
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
    });
  }
  if (['workflow', 'workflow_hint'].includes(result?.route) && currentCatalogEntities.length > 1) {
    result.catalogSelections = currentCatalogEntities.map((selection) => catalogResponse(selection.item, selection));
  } else if (['workflow', 'workflow_hint'].includes(result?.route) && currentCatalogResolution?.entityType === 'item') {
    result.catalogSelection = catalogResponse(currentCatalogResolution.item, currentCatalogResolution);
  }
  if (!result) return null;
  result.rankedEvidence = rankedEvidenceBundle(ranked);
  result.retrieval = {
    ...(result.retrieval ?? {}),
    parallelDurationMs: retrieval.durationMs,
    channelFailures: retrieval.failures,
    candidateCount: uniqueCandidates.length,
    confidence: confidence.highConfidence,
  };
  result.confidenceRouting = confidenceRoute;
  if (workflowHints.length) result.workflowHints = workflowHints;
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
  const currentCatalogEntities = resolveCatalogEntitiesLocally(profile.catalog_items, input.query, {
    minimumConfidence: confidence.highConfidence,
  });
  if (profile.agent_settings?.parallelHybridRetrievalEnabled === true) {
    const parallelResult = await parallelRankedKnowledgeResult({
      auth, profile, input, normalizedQuery, runtime, confidence,
      currentCatalogClassification, currentCatalogResolution, currentCatalogEntities,
    });
    return {
      ...(parallelResult ?? { route: 'none', found: false, content: null, source: null }),
      profileCacheHit: loaded.cacheHit,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
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
  if (!result && (input.routeHint === 'auto' || input.routeHint === 'conversation')) {
    result = conversationRoute(profile, input);
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
