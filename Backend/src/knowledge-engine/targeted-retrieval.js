import { embedQuery } from '../rag/embedding.client.js';
import { QDRANT_SEARCH_LIMIT_MAX, searchTenantPoints } from '../rag/qdrant.client.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { knowledgeSearchIndexes } from './query-classifier.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';
import {
  canonicalRecordIdentity,
  canonicalRecordIdentityKey,
  canonicalRecordNamespace,
} from './canonical-record-identity.js';
import { publishedRecordCallerFacingHint } from './evidence-audience.js';
import { selectCompleteConversationTurns } from './conversation-turn-context.js';
import { buildPublicationDeduplicationIdentity } from './publication-deduplication.js';

export const TARGETED_RETRIEVAL_VERSION = 8;

const documentIndexTypes = Object.freeze({
  [knowledgeSearchIndexes.CATALOG]: 'CATALOG_ITEM',
  [knowledgeSearchIndexes.FAQ]: 'FAQ',
  [knowledgeSearchIndexes.CONVERSATION]: 'CONVERSATION_NODE',
  [knowledgeSearchIndexes.WORKFLOW]: 'WORKFLOW_RULE',
  [knowledgeSearchIndexes.GENERAL]: 'KNOWLEDGE_CHUNK',
});

const defaultDependencies = Object.freeze({ embed: embedQuery, search: searchTenantPoints });

async function completeChannelWithin(channel, operation, timeoutMs) {
  const deadlineMs = Math.max(1, Number(timeoutMs));
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error(`Retrieval channel exceeded its completion deadline: ${channel}`),
      { code: 'RETRIEVAL_CHANNEL_TIMEOUT', channel, timeoutMs: deadlineMs },
    )), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const namespaceTypes = Object.freeze({
  CATALOG: Object.freeze(['CATALOG_ITEM', 'CATALOG_CATEGORY']),
  FAQ: Object.freeze(['FAQ']),
  CONVERSATION: Object.freeze(['CONVERSATION_NODE']),
  WORKFLOW: Object.freeze(['WORKFLOW_RULE']),
  GENERAL: Object.freeze(['KNOWLEDGE_CHUNK']),
});

const namespaceByRecordType = Object.freeze(Object.fromEntries(
  Object.entries(namespaceTypes).flatMap(([namespace, recordTypes]) => (
    recordTypes.map((recordType) => [recordType, namespace])
  )),
));

function normalizeId(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function normalizedUsage(value) {
  const usage = String(value ?? '').trim().toLocaleLowerCase();
  return ['inbound', 'outbound'].includes(usage) ? usage : null;
}

function tokens(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function uniqueText(values, maximum = 20) {
  return Object.freeze([...new Set((Array.isArray(values) ? values : [])
    .map((value) => clean(value, 240)).filter(Boolean))].slice(0, maximum));
}

function compactEntity(value, fallbackRecordType = 'CATALOG_ITEM') {
  if (!value || typeof value !== 'object') return null;
  const recordId = clean(value.recordId ?? value.id, 160);
  const name = clean(value.name ?? value.label ?? value.category, 240);
  const recordType = String(value.recordType ?? (value.entityType === 'CATEGORY'
    ? 'CATALOG_CATEGORY' : fallbackRecordType)).trim().toUpperCase();
  return recordId || name ? Object.freeze({
    recordId: recordId || null, name: name || null, recordType,
    tenantId: clean(value.tenantId, 160) || null,
    agentId: clean(value.agentId, 160) || null,
    knowledgeBaseId: clean(value.knowledgeBaseId, 160) || null,
    publicationRevision: Number.isInteger(Number(value.publicationRevision))
      ? Number(value.publicationRevision) : null,
  }) : null;
}

function canonicalMemoryEntity(input = {}) {
  // Only the explicitly committed active typed record is canonical memory.
  // Retrieved/known alternatives must never be promoted by retrieval.
  const memory = input.canonicalCallMemory ?? input.memory ?? {};
  const active = memory.activeEntity
    ? compactEntity(memory.activeEntity, 'CATALOG_ITEM')
    : compactEntity(memory.activeCategory, 'CATALOG_CATEGORY');
  return active?.recordId ? active : null;
}

function boundedScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, score) : 0;
}

function planIndexes(classification) {
  return new Set(classification?.retrievalPlan?.indexes ?? []);
}

function allowedRecordTypes(indexes) {
  const selected = [...indexes].flatMap((index) => (
    index === knowledgeSearchIndexes.CATALOG
      ? ['CATALOG_ITEM', 'CATALOG_CATEGORY']
      : [documentIndexTypes[index]].filter(Boolean)
  ));
  return new Set(selected.length ? selected : Object.values(documentIndexTypes));
}

function buildParallelRetrievalScope(input, scope, recordTypes, relevantNamespaces = []) {
  const namespaces = [...new Set((relevantNamespaces.length
    ? relevantNamespaces
    : [...recordTypes].map((recordType) => canonicalRecordNamespace(recordType)))
    .map((value) => String(value).trim().toUpperCase()).filter(Boolean))];
  return Object.freeze({
    tenantId: String(input.tenantId),
    agentId: String(input.agentId),
    knowledgeBases: Object.freeze(scope.map((entry) => Object.freeze({ ...entry }))),
    usageDirection: String(input.usageDirection),
    namespaces: Object.freeze(namespaces),
    recordTypes: Object.freeze([...recordTypes]),
  });
}

function activeWorkflowRecord(input, recordScope) {
  if (!(recordScope instanceof Map)) return null;
  const memory = input?.canonicalCallMemory ?? input?.memory ?? {};
  const active = memory.activeTool ?? memory.activeToolRequest;
  if (!active) return null;
  const recordId = normalizeId(active.authorizationRecordId
    ?? active.authorizationEvidenceId ?? active.workflowRecordId);
  const direct = recordId ? recordScope.get(recordId) : null;
  if (direct?.recordType === 'WORKFLOW_RULE') return direct;
  const activeName = normalizeId(active.name);
  return activeName ? [...recordScope.values()].find((record) => (
    record.recordType === 'WORKFLOW_RULE'
    && normalizeId(record.toolIdentifier) === activeName
  )) ?? null : null;
}

function tenantSearchForms(entities, recordScope) {
  if (!(recordScope instanceof Map)) return Object.freeze([]);
  const forms = [];
  for (const entity of entities) {
    if (!entity?.recordId) continue;
    const record = recordScope.get(normalizeId(entity.recordId));
    if (!record) continue;
    forms.push(record.canonicalName, ...(record.searchForms ?? []));
  }
  return uniqueText(forms, 30);
}

export function buildContextEnrichedRetrievalQuery(
  input, classification, resolution, scope = [], recordScope = new Map(),
) {
  const understanding = input?.queryUnderstanding ?? {};
  const explicit = [
    ...(understanding.explicitEntities ?? []),
    ...(understanding.explicitCategories ?? []),
  ].map(compactEntity).filter(Boolean);
  const currentMentions = (understanding.explicitEntities?.length
    || understanding.explicitCategories?.length) ? [] : [
    ...(understanding.ambiguity?.detected === true
      ? understanding.ambiguity.candidates ?? [] : []),
    understanding.confirmationCandidate,
  ].map(compactEntity).filter(Boolean);
  const comparisons = (understanding.comparisonEntities ?? [])
    .map(compactEntity).filter(Boolean).slice(0, 5);
  const memoryEntity = canonicalMemoryEntity(input);
  const understoodContext = compactEntity(understanding.canonicalContext);
  const hasExplicitCurrentEntity = explicit.length > 0;
  const hasCurrentEntityMention = hasExplicitCurrentEntity || currentMentions.length > 0;
  const contextDependent = understanding.contextDependent === true
    || resolution?.contextDependent === true;
  const canonicalEntity = hasExplicitCurrentEntity
    ? (understoodContext ?? explicit[0])
    : (contextDependent ? (understoodContext ?? memoryEntity) : null);
  const currentSearchEntity = canonicalEntity ?? currentMentions[0] ?? null;
  const requestedFacts = uniqueText([
    ...(understanding.requestedFacts ?? []),
    ...(input?.requestedFacts ?? []),
  ]);
  const relevantNamespace = clean(
    classification?.selectedNamespace
      ?? classification?.retrievalPlan?.namespace
      ?? resolution?.candidateNamespace,
    80,
  ).toUpperCase() || null;
  const relevantNamespaces = Object.freeze([...(classification?.relevantNamespaces ?? (
    relevantNamespace ? [relevantNamespace] : []
  ))].map((value) => clean(value, 80).toUpperCase()).filter(Boolean));
  const reserved = [];
  for (const entity of explicit) {
    if (!entity.recordId) continue;
    reserved.push(Object.freeze({ ...entity, reason: 'explicit_entity' }));
  }
  for (const entity of currentMentions) {
    if (!entity.recordId || explicit.some((value) => (
      normalizeId(value.recordId) === normalizeId(entity.recordId)
      && value.recordType === entity.recordType
    ))) continue;
    reserved.push(Object.freeze({ ...entity, reason: 'candidate_confirmation' }));
  }
  if (!explicit.length && resolution?.candidate?.explicit === true) {
    const resolved = compactEntity(resolution.candidate);
    if (resolved?.recordId) {
      reserved.push(Object.freeze({ ...resolved, reason: 'explicit_entity' }));
    }
  }
  if (!hasCurrentEntityMention && contextDependent && canonicalEntity?.recordId) {
    reserved.push(Object.freeze({ ...canonicalEntity, reason: 'canonical_memory' }));
  }
  for (const entity of comparisons) {
    if (!entity.recordId) continue;
    reserved.push(Object.freeze({ ...entity, reason: 'explicit_comparison' }));
  }
  const activeWorkflow = activeWorkflowRecord(input, recordScope);
  if (activeWorkflow?.recordId) {
    reserved.push(Object.freeze({
      recordId: activeWorkflow.recordId,
      recordType: 'WORKFLOW_RULE',
      name: activeWorkflow.canonicalName ?? null,
      reason: 'active_tool_authorization',
    }));
  }
  const reservedRecords = Object.freeze([...new Map(reserved.map((entry) => (
    [`${normalizeId(entry.recordType)}:${normalizeId(entry.recordId)}`, entry]
  ))).values()]);
  const currentQuestion = clean(input?.latestQuestion ?? input?.utterance);
  const need = understanding.need ?? {};
  const recentCompleteContext = (contextDependent || need.detected === true)
    ? selectCompleteConversationTurns(input?.recentRelevantTurns ?? [], {
      mode: 'full_current_call',
      currentQuestion,
      contextTerms: [currentSearchEntity?.name, ...requestedFacts].filter(Boolean),
      maximumPairs: 2,
    }).map((turn) => clean(turn?.content, 500)).filter(Boolean)
    : [];
  const tenantForms = tenantSearchForms([
    ...explicit,
    ...currentMentions,
    ...(canonicalEntity ? [canonicalEntity] : []),
    ...comparisons,
  ], recordScope);
  const primaryQueryParts = uniqueText([
    currentQuestion,
    currentSearchEntity?.name,
    ...requestedFacts,
    ...tenantForms,
    ...comparisons.map((entity) => entity.name),
    ...(need.detected === true ? [
      need.customerProblem,
      need.desiredOutcome,
      ...Object.values(need.businessContext ?? {}),
    ] : []),
  ]);
  const searchText = primaryQueryParts.join(' ');
  const contextualText = contextDependent ? uniqueText([
    ...primaryQueryParts,
    ...recentCompleteContext,
  ]).join(' ') : null;
  return Object.freeze({
    currentQuestion,
    canonicalEntity,
    currentEntityCandidate: currentMentions[0] ?? null,
    requestedFacts,
    relevantNamespace,
    relevantNamespaces,
    comparisonEntities: Object.freeze(comparisons),
    need: Object.freeze({
      detected: need.detected === true,
      customerProblem: clean(need.customerProblem, 800) || null,
      desiredOutcome: clean(need.desiredOutcome, 500) || null,
      requestedRecommendation: need.requestedRecommendation === true
        ? true : (need.requestedRecommendation === false ? false : null),
      missingDetails: Object.freeze([...(need.missingDetails ?? [])].slice(0, 10)),
    }),
    contextDependent,
    contextualText,
    requiresCanonicalHydration: !hasCurrentEntityMention
      && contextDependent && Boolean(canonicalEntity?.recordId),
    tenantSearchForms: tenantForms,
    latestRequestText: searchText,
    sparseText: searchText,
    semanticText: searchText,
    reservedRecords,
    filters: Object.freeze({
      tenantId: input.tenantId,
      agentId: input.agentId,
      knowledgeBases: Object.freeze(scope.map((entry) => Object.freeze({ ...entry }))),
      usageDirection: input.usageDirection,
      namespace: relevantNamespace,
      namespaces: relevantNamespaces,
    }),
  });
}

function publicationScope(input, bundles) {
  const tenant = normalizeId(input.tenantId);
  const agent = normalizeId(input.agentId);
  const usage = normalizedUsage(input.usageDirection);
  const scope = [];
  const records = new Map();
  for (const bundle of bundles) {
    if (normalizeId(bundle?.tenantId) !== tenant) {
      throw new TypeError('Targeted retrieval requires same-tenant publication bundles');
    }
    const assignedAgentIds = (bundle.assignedAgentIds ?? []).map(normalizeId).filter(Boolean);
    if (assignedAgentIds.length && !assignedAgentIds.includes(agent)) {
      throw new TypeError('Targeted retrieval requires publication bundles assigned to the active agent');
    }
    const knowledgeBaseId = String(bundle.knowledgeBaseId ?? '').trim();
    const publicationRevision = Number(bundle.publicationRevision);
    if (!knowledgeBaseId || !Number.isInteger(publicationRevision) || publicationRevision < 1) {
      throw new TypeError('Targeted retrieval requires revision-scoped publication bundles');
    }
    scope.push(Object.freeze({ id: knowledgeBaseId, publicationRevision }));
    for (const record of bundle.records ?? []) {
      const recordUsage = String(record.usage_direction ?? record.usageDirection ?? 'both')
        .trim().toLocaleLowerCase();
      if (!['both', usage].includes(recordUsage)) continue;
      const recordId = String(record.record_id ?? record.recordId ?? record.id ?? '').trim();
      if (!recordId) continue;
      const deduplicationIdentity = buildPublicationDeduplicationIdentity(record, {
        tenantId: input.tenantId, knowledgeBaseId, publicationRevision,
      });
      records.set(normalizeId(recordId), Object.freeze({
        tenantId: input.tenantId,
        agentId: input.agentId,
        recordId,
        recordType: String(record.record_type ?? record.recordType ?? record.type ?? '').toUpperCase(),
        namespace: canonicalRecordNamespace(
          record.record_type ?? record.recordType ?? record.type,
        ),
        knowledgeBaseId,
        publicationRevision,
        deduplicationIdentity,
        callerFacingHint: publishedRecordCallerFacingHint(record),
        toolIdentifier: String(
          record.entity_metadata?.actionConfig?.toolIdentifier
            ?? record.entity_metadata?.action_config?.tool_identifier
            ?? record.metadata?.actionConfig?.toolIdentifier
            ?? record.metadata?.action_config?.tool_identifier
            ?? '',
        ).trim() || null,
        itemKey: String(record.entity_metadata?.itemKey ?? record.metadata?.itemKey ?? '').trim() || null,
        categoryKey: String(record.entity_metadata?.categoryKey ?? record.metadata?.categoryKey ?? '').trim() || null,
        canonicalName: String(
          record.entity_name ?? record.entity_category ?? record.question
            ?? record.entity_metadata?.name ?? record.entity_metadata?.category ?? '',
        ).trim() || null,
        searchForms: uniqueText([
          record.entity_name,
          record.entity_category,
          record.question,
          ...(record.publicationAliases ?? record.entity_aliases ?? []),
          ...(record.publicationSttForms ?? []),
          ...(record.publicationPhoneticForms ?? []),
        ], 30),
        useCasePhrases: Object.freeze([...(record.publicationUseCasePhrases
          ?? record.useCasePhrases ?? [])]),
        useCaseTokens: Object.freeze([...(record.publicationUseCaseTokens
          ?? record.useCaseTokens ?? [])]),
      }));
    }
  }
  return { scope: Object.freeze(scope), records };
}

function freezeCandidate(candidate, channel, rank) {
  const canonicalIdentity = candidate.canonicalIdentity
    ? Object.freeze({ ...candidate.canonicalIdentity })
    : canonicalRecordIdentity(candidate);
  const identityKey = candidate.canonicalIdentityKey
    ?? canonicalRecordIdentityKey(canonicalIdentity);
  if (!identityKey) {
    throw new TypeError(`Retrieval channel ${channel} returned a candidate without canonical identity`);
  }
  return Object.freeze({
    recordId: String(candidate.recordId),
    recordType: String(candidate.recordType).toUpperCase(),
    knowledgeBaseId: String(candidate.knowledgeBaseId),
    publicationRevision: Number(candidate.publicationRevision),
    namespace: canonicalIdentity.namespace,
    canonicalIdentity,
    canonicalIdentityKey: identityKey,
    channel,
    rank,
    namespaceRank: Number(candidate.namespaceRank ?? rank),
    score: boundedScore(candidate.score),
    callerFacingHint: candidate.callerFacingHint === true,
    deduplicationIdentity: Object.freeze({ ...(candidate.deduplicationIdentity ?? {}) }),
    authorizationHint: candidate.authorizationHint === true,
    ...(candidate.tokenCoverage === undefined
      ? {} : { tokenCoverage: boundedScore(candidate.tokenCoverage) }),
    ...(candidate.matchMethod ? { matchMethod: String(candidate.matchMethod) } : {}),
    ...(candidate.categoryKey ? { categoryKey: String(candidate.categoryKey) } : {}),
    ...(Array.isArray(candidate.evidenceRecordIds)
      ? { evidenceRecordIds: Object.freeze([...candidate.evidenceRecordIds]) } : {}),
  });
}

function selectedNamespaceTypes(recordTypes) {
  return Object.freeze(Object.fromEntries(Object.entries(namespaceTypes).flatMap(
    ([namespace, types]) => {
      const selected = types.filter((type) => recordTypes.has(type));
      return selected.length ? [[namespace, new Set(selected)]] : [];
    },
  )));
}

function rankChannel(candidates, channel, limit) {
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${normalizeId(candidate.knowledgeBaseId)}:${normalizeId(candidate.recordId)}`;
    const current = unique.get(key);
    if (!current || candidate.score > current.score) unique.set(key, candidate);
  }
  return Object.freeze([...unique.values()]
    .sort((left, right) => right.score - left.score
      || normalizeId(left.recordId).localeCompare(normalizeId(right.recordId)))
    .slice(0, limit)
    .map((candidate, index) => freezeCandidate(candidate, channel, index + 1)));
}

function interleaveNamespaceRanks(namespaceRanks, channel, limit) {
  const orderedNamespaces = Object.keys(namespaceRanks);
  const merged = [];
  const seen = new Set();
  for (let rank = 0; merged.length < limit; rank += 1) {
    let appended = false;
    for (const namespace of orderedNamespaces) {
      const candidate = namespaceRanks[namespace]?.[rank];
      if (!candidate) continue;
      appended = true;
      const key = `${normalizeId(candidate.knowledgeBaseId)}:${normalizeId(candidate.recordId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
      if (merged.length >= limit) break;
    }
    if (!appended) break;
  }
  return Object.freeze(merged.map((candidate, index) => (
    freezeCandidate({
      ...candidate, namespaceRank: candidate.namespaceRank ?? candidate.rank,
    }, channel, index + 1)
  )));
}

function groupRankedCandidates(candidates, channel, limit) {
  const groups = {};
  for (const [namespace, types] of Object.entries(namespaceTypes)) {
    const allowed = new Set(types);
    groups[namespace] = rankChannel(candidates.filter((candidate) => (
      allowed.has(String(candidate.recordType ?? '').toUpperCase())
    )), channel, limit);
  }
  return Object.freeze(groups);
}

function structuredCandidates(resolution, recordScope, allowedTypes, limit) {
  const candidates = [];
  for (const resolved of resolution?.routingCandidates ?? []) {
    if ((resolved.entityType === 'CATEGORY' || resolved.recordType === 'CATALOG_CATEGORY')
      && allowedTypes.has('CATALOG_CATEGORY')) {
      const evidenceRecordIds = resolved.evidenceRecordIds ?? [resolved.recordId];
      const anchor = evidenceRecordIds.map((id) => recordScope.get(normalizeId(id)))
        .find((record) => record?.recordType === 'CATALOG_ITEM');
      if (anchor) candidates.push({
        ...anchor,
        recordType: 'CATALOG_CATEGORY',
        categoryKey: resolved.categoryKey ?? anchor.categoryKey,
        evidenceRecordIds,
        score: boundedScore(resolved.score),
        matchMethod: resolved.method,
      });
      // Child items belong to the hydrated category aggregate. They must not
      // compete with their parent as independent retrieval candidates.
      continue;
    }
    for (const evidenceId of resolved.evidenceRecordIds ?? [resolved.recordId]) {
      const scoped = recordScope.get(normalizeId(evidenceId));
      if (!scoped || !allowedTypes.has(scoped.recordType)) continue;
      candidates.push({
        ...scoped,
        score: boundedScore(resolved.score),
        matchMethod: resolved.method,
      });
    }
  }
  return rankChannel(candidates, 'structured', limit);
}

function activeCatalogCandidate(input, recordScope, allowedTypes) {
  const active = input?.canonicalCallMemory?.activeEntity ?? input?.memory?.activeEntity;
  if (active && allowedTypes.has('CATALOG_ITEM')) {
    const recordId = normalizeId(active.recordId ?? active.id);
    const direct = recordId ? recordScope.get(recordId) : null;
    if (direct?.recordType === 'CATALOG_ITEM') return direct;
    const itemKey = normalizeId(active.itemKey ?? active.key);
    const matched = itemKey ? [...recordScope.values()].find((record) => (
      record.recordType === 'CATALOG_ITEM' && normalizeId(record.itemKey) === itemKey
    )) : null;
    if (matched) return matched;
  }
  const activeCategory = input?.memory?.activeCategory;
  if (activeCategory && allowedTypes.has('CATALOG_CATEGORY')) {
    const categoryKey = normalizeId(activeCategory.categoryKey ?? activeCategory.key);
    const categoryRecordId = normalizeId(activeCategory.recordId ?? activeCategory.id);
    const directCategory = categoryRecordId ? recordScope.get(categoryRecordId) : null;
    if (directCategory?.recordType === 'CATALOG_CATEGORY') return directCategory;
    const children = [...recordScope.values()].filter((record) => (
      record.recordType === 'CATALOG_ITEM'
      && normalizeId(record.categoryKey) === categoryKey
    ));
    const anchor = children[0] ?? null;
    if (anchor) return {
      ...anchor,
      recordType: 'CATALOG_CATEGORY',
      categoryKey,
      evidenceRecordIds: children.map((record) => record.recordId),
    };
  }
  return null;
}

function structuredUseCaseCandidates(recordScope, allowedTypes, limit, queryContext) {
  if (queryContext?.need?.detected !== true || !allowedTypes.has('CATALOG_ITEM')) {
    return Object.freeze([]);
  }
  const queryTokens = new Set(tokens(queryContext.sparseText));
  if (!queryTokens.size) return Object.freeze([]);
  const candidates = [];
  for (const record of recordScope.values()) {
    if (record.recordType !== 'CATALOG_ITEM') continue;
    let bestScore = 0;
    for (const phrase of record.useCasePhrases ?? []) {
      const phraseTokens = [...new Set(tokens(phrase))];
      if (!phraseTokens.length) continue;
      const matched = phraseTokens.filter((token) => queryTokens.has(token)).length;
      const coverage = matched / phraseTokens.length;
      const sufficient = phraseTokens.length === 1 ? matched === 1
        : matched >= 2 && coverage >= 0.5;
      if (!sufficient) continue;
      bestScore = Math.max(bestScore, Math.min(0.98, 0.6 + (coverage * 0.35)));
    }
    if (!bestScore) continue;
    candidates.push({
      ...record,
      score: bestScore,
      matchMethod: 'published_use_case',
    });
  }
  return rankChannel(candidates, 'structured', limit);
}

function activeWorkflowCandidate(input, recordScope, allowedTypes) {
  if (!allowedTypes.has('WORKFLOW_RULE')) return null;
  const memory = input?.canonicalCallMemory ?? input?.memory ?? {};
  const active = memory.activeTool ?? memory.activeToolRequest;
  if (!active) return null;
  const recordId = normalizeId(active.authorizationRecordId
    ?? active.authorizationEvidenceId ?? active.workflowRecordId);
  const direct = recordId ? recordScope.get(recordId) : null;
  if (direct?.recordType === 'WORKFLOW_RULE') return direct;
  const activeName = normalizeId(active.name);
  return activeName ? [...recordScope.values()].find((record) => (
    record.recordType === 'WORKFLOW_RULE'
    && normalizeId(record.toolIdentifier) === activeName
  )) ?? null : null;
}

function structuredCandidatesForTurn(input, classification, resolution, recordScope, allowedTypes, limit, queryContext) {
  const confidenceConfiguration = resolveKnowledgeConfidenceConfiguration(
    classification?.confidenceConfiguration ?? resolution?.confidenceConfiguration,
  );
  const continuingActiveTool = Boolean(input?.memory?.activeTool?.name)
    && classification?.source === 'active_tool_workflow';
  const selectedResolution = continuingActiveTool
    ? { routingCandidates: [] }
    : classification?.intentClass !== 'COMPARISON_COMPLEX'
    && classification?.candidate
    && resolution?.action !== 'CONFIRM'
      ? { routingCandidates: [classification.candidate] }
      : resolution;
  const candidates = [...structuredCandidates(selectedResolution, recordScope, allowedTypes, limit)];
  for (const candidate of structuredUseCaseCandidates(
    recordScope, allowedTypes, limit, queryContext,
  )) {
    const existing = candidates.findIndex((entry) => (
      normalizeId(entry.recordId) === normalizeId(candidate.recordId)
      && entry.recordType === candidate.recordType
    ));
    if (existing >= 0) {
      if (candidate.score > candidates[existing].score) candidates[existing] = candidate;
    } else candidates.push(candidate);
  }
  const activeWorkflow = activeWorkflowCandidate(input, recordScope, allowedTypes);
  if (activeWorkflow && !candidates.some((candidate) => (
    normalizeId(candidate.recordId) === normalizeId(activeWorkflow.recordId)
    && candidate.recordType === 'WORKFLOW_RULE'
  ))) {
    candidates.push({
      ...activeWorkflow,
      score: 1,
      matchMethod: 'active_tool_authorization',
      authorizationHint: true,
    });
  }
  if (classification?.intentClass === 'ACTION_TOOL_REQUEST') {
    const explicitCatalog = (resolution?.namespaceCandidates?.CATALOG ?? []).filter((candidate) => (
      candidate.explicit === true
      && Number(candidate.score ?? 0) >= confidenceConfiguration.highConfidence
    )).flatMap((candidate) => (
      candidate.evidenceRecordIds ?? [candidate.recordId]
    )).map((recordId) => recordScope.get(normalizeId(recordId))).filter((record) => (
      record?.recordType === 'CATALOG_ITEM' && allowedTypes.has(record.recordType)
    ));
    const remembered = [
      activeWorkflowCandidate(input, recordScope, allowedTypes),
      activeCatalogCandidate(input, recordScope, allowedTypes),
      ...explicitCatalog,
    ].filter(Boolean);
    for (const active of remembered) {
      if (candidates.some((candidate) => normalizeId(candidate.recordId) === normalizeId(active.recordId))) continue;
      candidates.push(freezeCandidate({ ...active, score: 1, matchMethod: 'call_memory' },
        'structured', candidates.length + 1));
    }
  }
  if (queryContext?.contextDependent === true) {
    const rememberedCatalog = activeCatalogCandidate(input, recordScope, allowedTypes);
    if (rememberedCatalog) {
      const priorIndex = candidates.findIndex((candidate) => (
        normalizeId(candidate.recordId) === normalizeId(rememberedCatalog.recordId)
        && candidate.recordType === rememberedCatalog.recordType
      ));
      if (priorIndex >= 0) candidates.splice(priorIndex, 1);
      candidates.unshift(freezeCandidate({
        ...rememberedCatalog, score: 1, matchMethod: 'call_memory',
      }, 'structured', 1));
    }
  }
  for (const reserved of [...(queryContext?.reservedRecords ?? [])].reverse()) {
    const existingIndex = candidates.findIndex((candidate) => (
      normalizeId(candidate.recordId) === normalizeId(reserved.recordId)
      && String(candidate.recordType).toUpperCase() === reserved.recordType
    ));
    let selected = existingIndex >= 0 ? candidates.splice(existingIndex, 1)[0] : null;
    if (!selected) {
      const scoped = recordScope.get(normalizeId(reserved.recordId));
      if (scoped && allowedTypes.has(reserved.recordType)
        && (scoped.recordType === reserved.recordType
          || reserved.recordType === 'CATALOG_CATEGORY')) {
        selected = {
          ...scoped,
          recordType: reserved.recordType,
          score: 1,
          matchMethod: reserved.reason,
        };
      }
    }
    if (selected) candidates.unshift(selected);
  }
  return interleaveNamespaceRanks(
    groupRankedCandidates(candidates, 'structured', limit), 'structured', limit,
  );
}

function validSparseDocuments(indexes, input, scope, allowedTypes) {
  const allowedScope = new Map(scope.map((entry) => [normalizeId(entry.id), entry.publicationRevision]));
  const tenant = normalizeId(input.tenantId);
  const usage = normalizedUsage(input.usageDirection);
  return indexes.flatMap((index) => index?.documents ?? []).filter((document) => (
    normalizeId(document.tenantId) === tenant
    && allowedScope.get(normalizeId(document.knowledgeBaseId)) === Number(document.publicationRevision)
    && allowedTypes.has(String(document.recordType ?? '').toUpperCase())
    && ['both', usage].includes(String(document.usageDirection ?? 'both').toLocaleLowerCase())
  ));
}

function bm25Candidates(
  input, sparseIndexes, scope, allowedTypes, limit, queryContext, recordScope,
) {
  const queryTokens = [...new Set(tokens(queryContext?.sparseText ?? input.utterance))];
  if (!queryTokens.length) return Object.freeze([]);
  const groups = selectedNamespaceTypes(allowedTypes);
  const namespaceRanks = {};
  for (const [namespace, namespaceAllowedTypes] of Object.entries(groups)) {
    const documents = validSparseDocuments(sparseIndexes, input, scope, namespaceAllowedTypes);
    if (!documents.length) {
      namespaceRanks[namespace] = Object.freeze([]);
      continue;
    }
  const documentFrequency = {};
  for (const document of documents) {
    for (const token of new Set(document.tokens ?? [])) {
      documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
    }
  }
  const averageLength = documents.reduce(
    (sum, document) => sum + Math.max(1, document.tokens?.length ?? 0), 0,
  ) / documents.length;
    const ranked = documents.flatMap((document) => {
    const frequencies = new Map();
    for (const token of document.tokens ?? []) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    let score = 0;
    let matched = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (!frequency) continue;
      matched += 1;
      const frequencyAcrossDocuments = documentFrequency[token] ?? 0;
      const inverseFrequency = Math.log(1 + (documents.length - frequencyAcrossDocuments + 0.5)
        / (frequencyAcrossDocuments + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75
        * ((document.tokens?.length ?? 0) / Math.max(1, averageLength)));
      score += inverseFrequency * ((frequency * 2.2) / denominator);
    }
    if (!matched || score <= 0) return [];
    return [{
      tenantId: input.tenantId,
      agentId: input.agentId,
      recordId: document.id,
      recordType: document.recordType,
      namespace: canonicalRecordNamespace(document.recordType),
      knowledgeBaseId: document.knowledgeBaseId,
      publicationRevision: document.publicationRevision,
      callerFacingHint: recordScope.get(normalizeId(document.id))?.callerFacingHint === true,
      deduplicationIdentity: recordScope.get(normalizeId(document.id))?.deduplicationIdentity,
      score,
      tokenCoverage: matched / queryTokens.length,
    }];
    });
    namespaceRanks[namespace] = rankChannel(ranked, 'bm25', limit);
  }
  return interleaveNamespaceRanks(namespaceRanks, 'bm25', limit);
}

function semanticPayloadCandidate(match, scope, input, allowedTypes, recordScope) {
  const payload = match?.payload ?? {};
  const allowedScope = new Map(scope.map((entry) => [normalizeId(entry.id), entry.publicationRevision]));
  const knowledgeBaseId = String(payload.knowledge_base_id ?? '').trim();
  const publicationRevision = Number(payload.publication_revision);
  const recordType = String(payload.record_type ?? '').toUpperCase();
  const usage = String(payload.agent_usage ?? '').toLocaleLowerCase();
  if (normalizeId(payload.tenant_id) !== normalizeId(input.tenantId)
    || allowedScope.get(normalizeId(knowledgeBaseId)) !== publicationRevision
    || !allowedTypes.has(recordType)
    || ![normalizedUsage(input.usageDirection), 'both'].includes(usage)) return null;
  const recordId = String(payload.record_id ?? match.id ?? '').trim();
  const scopedRecord = recordScope.get(normalizeId(recordId));
  return recordId ? {
    tenantId: input.tenantId,
    agentId: input.agentId,
    recordId,
    recordType,
    namespace: canonicalRecordNamespace(recordType),
    knowledgeBaseId,
    publicationRevision,
    callerFacingHint: scopedRecord?.callerFacingHint === true,
    deduplicationIdentity: scopedRecord?.deduplicationIdentity,
    score: boundedScore(match.score),
  } : null;
}

async function semanticCandidates(
  input, scope, allowedTypes, limit, dependencies, queryContext, recordScope,
) {
  if (!scope.length || input.abortSignal?.aborted) return Object.freeze([]);
  const vector = await dependencies.embed(
    queryContext?.semanticText ?? input.utterance, { signal: input.abortSignal },
  );
  const namespaceGroups = selectedNamespaceTypes(allowedTypes);
  const namespaceEntries = Object.entries(namespaceGroups);
  const settledNamespaces = await Promise.allSettled(namespaceEntries
    .map(async ([namespace, namespaceAllowedTypes]) => {
      const matches = await dependencies.search(input.tenantId, vector, {
        knowledgeBases: scope,
        usageDirection: input.usageDirection,
        agentId: input.agentId,
        abortSignal: input.abortSignal,
        limit: Math.min(QDRANT_SEARCH_LIMIT_MAX, limit),
        scoreThreshold: 0,
        recordTypes: [...namespaceAllowedTypes],
      });
      const scoped = (matches ?? []).map((match) => semanticPayloadCandidate(
        match, scope, input, namespaceAllowedTypes, recordScope,
      )).filter(Boolean);
      return [namespace, rankChannel(scoped, 'qdrant', limit)];
    }));
  const failedNamespaces = settledNamespaces
    .map((result, index) => ({ result, namespace: namespaceEntries[index][0] }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, namespace } of failedNamespaces) {
    logger.warn({
      err: result.reason,
      stage: 'knowledge.retrieval_namespace_failed',
      channel: 'qdrant',
      namespace,
    }, 'Knowledge retrieval namespace failed; retaining successful namespaces');
  }
  if (failedNamespaces.length === namespaceEntries.length && failedNamespaces.length > 0) {
    throw failedNamespaces[0].result.reason;
  }
  const namespaceResults = settledNamespaces.map((result, index) => (
    result.status === 'fulfilled' ? result.value : [namespaceEntries[index][0], []]
  ));
  return interleaveNamespaceRanks(
    Object.fromEntries(namespaceResults), 'qdrant', limit,
  );
}

function namespaceChannelView(channelCandidates) {
  const grouped = Object.fromEntries(Object.keys(namespaceTypes).map((namespace) => [namespace, []]));
  for (const candidate of channelCandidates) {
    const namespace = namespaceByRecordType[candidate.recordType];
    if (namespace) grouped[namespace].push(candidate);
  }
  return Object.freeze(Object.fromEntries(Object.entries(grouped).map(
    ([namespace, candidates]) => [namespace, Object.freeze(candidates)],
  )));
}

export async function retrieveTargetedCandidates({
  input,
  classification,
  resolution,
  publicationBundles,
  sparseIndexes = [],
  limitPerChannel = 12,
}, suppliedDependencies = {}) {
  if (!input?.tenantId || !input?.agentId || !input?.callId || !input?.utterance) {
    throw new TypeError('Targeted retrieval requires a finalized knowledge-engine input');
  }
  if (classification?.tenantId !== input.tenantId
    || classification?.agentId !== input.agentId
    || classification?.callId !== input.callId) {
    throw new TypeError('Targeted retrieval requires a classifier result from the same call');
  }
  if (!Number.isInteger(limitPerChannel) || limitPerChannel < 1 || limitPerChannel > 50) {
    throw new TypeError('limitPerChannel must be between 1 and 50');
  }
  const bundles = Array.isArray(publicationBundles) ? publicationBundles : [publicationBundles];
  const { scope, records } = publicationScope(input, bundles);
  const indexes = planIndexes(classification);
  const recordTypes = allowedRecordTypes(indexes);
  const dependencies = { ...defaultDependencies, ...suppliedDependencies };
  const channelDeadlineMs = Number(
    dependencies.channelDeadlineMs ?? env.RAG_RUNTIME_CHANNEL_DEADLINE_MS,
  );
  const semanticDeadlineMs = Number(
    dependencies.semanticDeadlineMs ?? env.RAG_RUNTIME_SEMANTIC_DEADLINE_MS,
  );
  const queryContext = buildContextEnrichedRetrievalQuery(
    input, classification, resolution, scope, records,
  );
  const parallelScope = buildParallelRetrievalScope(
    input, scope, recordTypes, classification?.relevantNamespaces ?? [],
  );
  const channelFailures = [];

  async function isolateChannel(channel, operation) {
    try {
      return await operation();
    } catch (error) {
      const diagnostic = Object.freeze({
        channel,
        code: String(error?.code ?? error?.name ?? 'RETRIEVAL_CHANNEL_FAILED'),
        message: String(error?.message ?? error).slice(0, 500),
      });
      channelFailures.push(diagnostic);
      logger.warn({
        err: error,
        stage: 'knowledge.retrieval_channel_failed',
        tenantId: input.tenantId,
        agentId: input.agentId,
        callId: input.callId,
        ...diagnostic,
      }, 'A hybrid retrieval channel failed; healthy channels will continue');
      return Object.freeze([]);
    }
  }

  const structuredPromise = isolateChannel('structured', async () => {
    dependencies.onChannelStart?.('structured', parallelScope);
    return completeChannelWithin('structured', () => structuredCandidatesForTurn(
      input, classification, resolution, records, recordTypes, limitPerChannel, queryContext,
    ), channelDeadlineMs);
  });
  const bm25Promise = indexes.has(knowledgeSearchIndexes.BM25)
    ? isolateChannel('bm25', async () => {
      dependencies.onChannelStart?.('bm25', parallelScope);
      return completeChannelWithin('bm25', () => bm25Candidates(
        input, sparseIndexes, scope, recordTypes, limitPerChannel, queryContext, records,
      ), channelDeadlineMs);
    })
    : Promise.resolve(Object.freeze([]));
  const qdrantPromise = indexes.has(knowledgeSearchIndexes.SEMANTIC)
    ? isolateChannel('qdrant', async () => {
      dependencies.onChannelStart?.('qdrant', parallelScope);
      return completeChannelWithin('qdrant', () => semanticCandidates(
        input, scope, recordTypes, limitPerChannel, dependencies, queryContext, records,
      ), semanticDeadlineMs);
    })
    : Promise.resolve(Object.freeze([]));
  const [structured, bm25, qdrant] = await Promise.all([
    structuredPromise, bm25Promise, qdrantPromise,
  ]);

  return Object.freeze({
    version: TARGETED_RETRIEVAL_VERSION,
    tenantId: input.tenantId,
    agentId: input.agentId,
    callId: input.callId,
    intentClass: classification.intentClass,
    searchedIndexes: Object.freeze([...indexes]),
    recordTypes: Object.freeze([...recordTypes]),
    relevantNamespaces: Object.freeze([...(classification?.relevantNamespaces ?? [])]),
    primaryNamespaces: Object.freeze([...(classification?.primaryNamespaces ?? [])]),
    retrievalScope: parallelScope,
    queryContext,
    channels: Object.freeze({ structured, bm25, qdrant }),
    namespaceChannels: Object.freeze({
      structured: namespaceChannelView(structured),
      bm25: namespaceChannelView(bm25),
      qdrant: namespaceChannelView(qdrant),
    }),
    channelFailures: Object.freeze([...channelFailures]),
    channelDeadlines: Object.freeze({
      structuredMs: channelDeadlineMs,
      bm25Ms: channelDeadlineMs,
      qdrantMs: semanticDeadlineMs,
    }),
    candidateCount: structured.length + bm25.length + qdrant.length,
  });
}
