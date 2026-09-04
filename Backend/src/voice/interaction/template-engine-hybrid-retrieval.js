import { AppError } from '../../middleware/errors.js';
import {
  canonicalRecordIdentity,
  canonicalRecordIdentityKey,
  canonicalRecordNamespace,
} from '../../knowledge-engine/canonical-record-identity.js';
import { normalizeTemplateEngineSearchDecision } from './template-engine-search-request.js';

export const TEMPLATE_ENGINE_HYBRID_RETRIEVAL_VERSION = 1;

const channelNames = Object.freeze(['structured', 'bm25', 'qdrant']);
const reciprocalRankConstant = 60;

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function publicationScope(values) {
  if (!Array.isArray(values)) return Object.freeze([]);
  const seen = new Set();
  const publications = [];
  for (const value of values) {
    const knowledgeBaseId = cleanText(value?.knowledgeBaseId, 160);
    const publicationRevision = Number(value?.publicationRevision);
    const key = `${knowledgeBaseId}:${publicationRevision}`;
    if (!knowledgeBaseId || !Number.isInteger(publicationRevision)
      || publicationRevision < 1 || seen.has(key)) continue;
    seen.add(key);
    publications.push(Object.freeze({ knowledgeBaseId, publicationRevision }));
  }
  return Object.freeze(publications);
}

function normalizedScope(value = {}) {
  const tenantId = cleanText(value.tenantId, 160);
  const agentId = cleanText(value.agentId, 160);
  const publications = publicationScope(value.publications);
  if (!tenantId || !agentId || !publications.length) {
    throw new TypeError('Hybrid retrieval requires tenant, agent and publication scope');
  }
  return Object.freeze({
    tenantId,
    agentId,
    usageDirection: cleanText(value.usageDirection ?? 'inbound', 20).toLocaleLowerCase(),
    publications,
  });
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

export function createTemplateEngineHybridRetrievalRequest({
  decision, state = {}, scope, limitPerChannel = 20, candidateLimit = 20, abortSignal = null,
} = {}) {
  const normalizedDecision = normalizeTemplateEngineSearchDecision(decision, state);
  if (!normalizedDecision.valid || normalizedDecision.value.decision !== 'SEARCH') {
    throw new TypeError('Hybrid retrieval requires a valid SEARCH decision');
  }
  return Object.freeze({
    version: TEMPLATE_ENGINE_HYBRID_RETRIEVAL_VERSION,
    search: normalizedDecision.value.search,
    scope: normalizedScope(scope),
    limitPerChannel: boundedInteger(limitPerChannel, 20, 50),
    candidateLimit: boundedInteger(candidateLimit, 20, 50),
    abortSignal,
  });
}

function resultCandidates(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.candidates) ? value.candidates : [];
}

function same(value, expected) {
  return cleanText(value, 160).toLocaleLowerCase()
    === cleanText(expected, 160).toLocaleLowerCase();
}

function boundedScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function tokens(value) {
  return [...new Set(cleanText(value, 4_000).toLocaleLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])];
}

function textList(value, maximum = 40) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...new Set(value.map((entry) => cleanText(entry, 300))
    .filter(Boolean))].slice(0, maximum));
}

function candidateForms(candidate) {
  return textList([
    candidate.canonicalName,
    candidate.itemKey,
    candidate.categoryKey,
    candidate.sourceSection,
    ...(candidate.searchForms ?? []),
    ...(candidate.useCaseTokens ?? []),
  ]);
}

function entityForms(candidate) {
  const scopedForms = candidate.recordType === 'CATALOG_ITEM'
    ? candidate.itemSearchForms
    : candidate.recordType === 'CATALOG_CATEGORY'
      ? candidate.categorySearchForms : null;
  return textList(scopedForms?.length ? scopedForms : [
    candidate.canonicalName,
    candidate.itemKey,
    ...(candidate.searchForms ?? []),
  ]);
}

function coverage(needles, haystack) {
  if (!needles.length || !haystack.length) return 0;
  const available = new Set(haystack);
  return needles.filter((token) => available.has(token)).length / needles.length;
}

function requestRelevance(candidate, search) {
  const formTokens = tokens(candidateForms(candidate).join(' '));
  const queryCoverage = coverage(tokens(search.query), formTokens);
  const factCoverage = coverage(tokens(search.requestedFact), formTokens);
  const contextCoverage = coverage(tokens(search.contextualReference), formTokens);
  const publishedCoverage = boundedScore(candidate.tokenCoverage);
  const provider = boundedScore(candidate.providerScore);
  return Math.max(
    provider,
    publishedCoverage,
    queryCoverage,
    (queryCoverage * 0.55) + (contextCoverage * 0.35) + (factCoverage * 0.1),
  );
}

function requestAlignment(candidate, search) {
  const formTokens = tokens(candidateForms(candidate).join(' '));
  return Math.max(
    coverage(tokens(search.query), formTokens),
    coverage(tokens(search.requestedFact), formTokens),
    coverage(tokens(search.contextualReference), formTokens),
  );
}

function explicitlyNamed(candidate, search) {
  if (candidate.recordType !== 'CATALOG_ITEM') return false;
  const requestTokens = new Set(tokens([
    search.query, search.contextualReference,
  ].filter(Boolean).join(' ')));
  return entityForms(candidate).some((form) => {
    const formTokens = tokens(form);
    return formTokens.length > 0 && formTokens.every((token) => requestTokens.has(token));
  });
}

function plainMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  return Object.freeze({ ...value });
}

function normalizeCandidate(candidate, channel, rank, scope, allowedPublications) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const tenantId = cleanText(candidate.tenantId ?? candidate.tenant_id, 160);
  const agentId = cleanText(candidate.agentId ?? candidate.agent_id, 160);
  const knowledgeBaseId = cleanText(
    candidate.knowledgeBaseId ?? candidate.knowledge_base_id, 160,
  );
  const publicationRevision = Number(
    candidate.publicationRevision ?? candidate.publication_revision,
  );
  const recordId = cleanText(candidate.recordId ?? candidate.record_id ?? candidate.id, 160);
  const recordType = cleanText(
    candidate.recordType ?? candidate.record_type ?? candidate.type, 80,
  ).toLocaleUpperCase();
  const publicationKey = `${knowledgeBaseId.toLocaleLowerCase()}:${publicationRevision}`;
  if (!tenantId || !knowledgeBaseId || !Number.isInteger(publicationRevision)
    || !recordId || !recordType || !same(tenantId, scope.tenantId)
    || (agentId && !same(agentId, scope.agentId))
    || !allowedPublications.has(publicationKey)) {
    throw new AppError(500, 'A retrieval channel returned a record outside its query scope',
      'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_VIOLATION', {
        channel, recordId: recordId || null,
      });
  }
  const providerScore = Number(candidate.score ?? candidate.similarity ?? 0);
  const normalized = {
    tenantId,
    agentId: agentId || scope.agentId,
    knowledgeBaseId,
    publicationRevision,
    recordId,
    recordType,
    namespace: canonicalRecordNamespace(recordType),
    channel,
    rank,
    namespaceRank: Number.isInteger(Number(candidate.namespaceRank))
      && Number(candidate.namespaceRank) > 0 ? Number(candidate.namespaceRank) : rank,
    score: Number.isFinite(providerScore) ? providerScore : 0,
    providerScore: Number.isFinite(providerScore) ? providerScore : 0,
    callerFacingHint: candidate.callerFacingHint === true,
    authorizationHint: candidate.authorizationHint === true,
    deduplicationIdentity: plainMetadata(candidate.deduplicationIdentity),
    sourceSection: cleanText(candidate.sourceSection ?? candidate.source_section, 300) || null,
    sourceLine: Number.isInteger(Number(candidate.sourceLine ?? candidate.source_line))
      ? Number(candidate.sourceLine ?? candidate.source_line) : null,
    ...(candidate.tokenCoverage === undefined ? {} : {
      tokenCoverage: boundedScore(candidate.tokenCoverage),
    }),
    ...(cleanText(candidate.categoryKey ?? candidate.category_key, 160) ? {
      categoryKey: cleanText(candidate.categoryKey ?? candidate.category_key, 160),
    } : {}),
    ...(cleanText(candidate.itemKey ?? candidate.item_key, 160) ? {
      itemKey: cleanText(candidate.itemKey ?? candidate.item_key, 160),
    } : {}),
    ...(cleanText(candidate.canonicalName ?? candidate.canonical_name, 300) ? {
      canonicalName: cleanText(candidate.canonicalName ?? candidate.canonical_name, 300),
    } : {}),
    ...(Array.isArray(candidate.searchForms) ? {
      searchForms: textList(candidate.searchForms),
    } : {}),
    ...(Array.isArray(candidate.itemSearchForms) ? {
      itemSearchForms: textList(candidate.itemSearchForms),
    } : {}),
    ...(Array.isArray(candidate.categorySearchForms) ? {
      categorySearchForms: textList(candidate.categorySearchForms),
    } : {}),
    ...(Array.isArray(candidate.useCaseTokens) ? {
      useCaseTokens: textList(candidate.useCaseTokens),
    } : {}),
    ...(cleanText(candidate.matchMethod, 160) ? {
      matchMethod: cleanText(candidate.matchMethod, 160),
    } : {}),
    ...(Array.isArray(candidate.evidenceRecordIds) ? {
      evidenceRecordIds: Object.freeze([...new Set(candidate.evidenceRecordIds
        .map((id) => cleanText(id, 160)).filter(Boolean))].slice(0, 50)),
    } : {}),
  };
  const canonicalIdentity = canonicalRecordIdentity(normalized);
  const identityKey = canonicalRecordIdentityKey(canonicalIdentity);
  if (!identityKey) {
    throw new AppError(500, 'A retrieval candidate has no canonical identity',
      'TEMPLATE_ENGINE_RETRIEVAL_IDENTITY_INVALID', { channel, recordId });
  }
  return Object.freeze({
    ...normalized,
    canonicalIdentity,
    canonicalIdentityKey: identityKey,
  });
}

function recordIdentity(candidate) {
  return [
    candidate.tenantId.toLocaleLowerCase(),
    candidate.knowledgeBaseId.toLocaleLowerCase(),
    candidate.publicationRevision,
    candidate.recordType,
    candidate.recordId.toLocaleLowerCase(),
  ].join(':');
}

function fuseAndRank(channels, request) {
  const preferred = new Set(request.search.preferredRecordIds.map((id) => id.toLocaleLowerCase()));
  const byIdentity = new Map();
  for (const channel of channelNames) {
    for (const candidate of channels[channel]) {
      const key = recordIdentity(candidate);
      const aggregate = byIdentity.get(key) ?? {
        candidate, channelRanks: {}, providerScores: {}, reciprocalRankScore: 0,
      };
      if (aggregate.channelRanks[channel] === undefined) {
        const namespaceRank = candidate.namespaceRank ?? candidate.rank;
        aggregate.channelRanks[channel] = namespaceRank;
        aggregate.providerScores[channel] = candidate.providerScore;
        aggregate.reciprocalRankScore += 1 / (reciprocalRankConstant + namespaceRank);
      }
      byIdentity.set(key, aggregate);
    }
  }
  const ranked = [...byIdentity.values()].map((aggregate) => {
    const preferredRecord = preferred.has(aggregate.candidate.recordId.toLocaleLowerCase());
    const intentRelevance = requestRelevance(aggregate.candidate, request.search);
    const intentAlignment = requestAlignment(aggregate.candidate, request.search);
    return Object.freeze({
      ...aggregate.candidate,
      channels: Object.freeze(Object.keys(aggregate.channelRanks)),
      channelRanks: Object.freeze(aggregate.channelRanks),
      providerScores: Object.freeze(aggregate.providerScores),
      preferredRecord,
      intentRelevance,
      intentAlignment,
      score: aggregate.reciprocalRankScore + (intentRelevance * 0.04)
        + (preferredRecord ? 0.08 : 0),
    });
  }).sort((left, right) => (
    right.score - left.score
    || right.intentRelevance - left.intentRelevance
    || right.channels.length - left.channels.length
    || left.recordId.localeCompare(right.recordId)
  ));

  const explicitlyRequested = ranked.filter((candidate) => explicitlyNamed(
    candidate, request.search,
  ));
  const exactStructured = ranked.filter((candidate) => (
    candidate.channels.includes('structured')
      && ['published_exact', 'published_category_exact', 'published_guidance_exact',
        'published_reference_exact'].includes(candidate.matchMethod)
  ));
  const inferredComparisonIds = new Set(explicitlyRequested.length > 1
    ? explicitlyRequested.map((candidate) => candidate.recordId.toLocaleLowerCase()) : []);
  const exactIds = new Set(exactStructured.map((candidate) => candidate.recordId.toLocaleLowerCase()));
  const strictIds = preferred.size > 1
    ? preferred
    : inferredComparisonIds.size > 1
      ? inferredComparisonIds : exactIds;
  if (strictIds.size > 0) {
    return Object.freeze(ranked.filter((candidate) => (
      strictIds.has(candidate.recordId.toLocaleLowerCase())
    )).slice(0, request.candidateLimit));
  }

  const best = ranked[0]?.intentRelevance ?? 0;
  const bestAlignment = Math.max(0, ...ranked.map((candidate) => candidate.intentAlignment));
  return Object.freeze(ranked.filter((candidate) => (
    candidate.preferredRecord
      || explicitlyNamed(candidate, request.search)
      || (candidate.callerFacingHint === true && (
        (candidate.channels.length > 1 && (
          bestAlignment === 0 || candidate.intentAlignment > 0
        ))
        || (candidate.intentAlignment > 0
          && candidate.intentRelevance >= Math.max(0.2, best - 0.2))
      ))
      || candidate.authorizationHint === true
  )).slice(0, request.candidateLimit));
}

function reservationFor(candidate, reason) {
  return Object.freeze({
    tenantId: candidate.tenantId,
    agentId: candidate.agentId,
    knowledgeBaseId: candidate.knowledgeBaseId,
    publicationRevision: candidate.publicationRevision,
    recordId: candidate.recordId,
    recordType: candidate.recordType,
    categoryKey: candidate.categoryKey ?? null,
    reason,
  });
}

export async function runTemplateEngineHybridRetrieval(input = {}, dependencies = {}) {
  const request = createTemplateEngineHybridRetrievalRequest(input);
  const searchers = Object.freeze({
    structured: dependencies.searchStructuredPostgres,
    bm25: dependencies.searchBm25,
    qdrant: dependencies.searchQdrantE5,
  });
  if (Object.values(searchers).some((search) => typeof search !== 'function')) {
    throw new TypeError('Hybrid retrieval requires all three search channel adapters');
  }
  const channelRequest = Object.freeze({
    query: request.search.query,
    requestedFact: request.search.requestedFact,
    contextualReference: request.search.contextualReference,
    preferredRecordIds: request.search.preferredRecordIds,
    scope: request.scope,
    limit: request.limitPerChannel,
    abortSignal: request.abortSignal,
  });
  const settled = await Promise.allSettled(channelNames.map(async (channel) => (
    resultCandidates(await searchers[channel](channelRequest)).slice(0, request.limitPerChannel)
  )));
  const allowedPublications = new Set(request.scope.publications.map((publication) => (
    `${publication.knowledgeBaseId.toLocaleLowerCase()}:${publication.publicationRevision}`
  )));
  const failures = [];
  const channels = {};
  for (let index = 0; index < channelNames.length; index += 1) {
    const channel = channelNames[index];
    const result = settled[index];
    if (result.status === 'rejected') {
      failures.push(Object.freeze({
        channel,
        code: cleanText(result.reason?.code ?? result.reason?.name ?? 'CHANNEL_FAILED', 120),
      }));
      channels[channel] = Object.freeze([]);
      continue;
    }
    channels[channel] = Object.freeze(result.value.map((candidate, candidateIndex) => (
      normalizeCandidate(candidate, channel, candidateIndex + 1, request.scope, allowedPublications)
    )).filter(Boolean));
  }
  if (failures.length === channelNames.length) {
    throw new AppError(503, 'Every hybrid retrieval channel failed',
      'TEMPLATE_ENGINE_RETRIEVAL_UNAVAILABLE', { failures });
  }
  const rawChannels = Object.freeze(channels);
  const candidates = fuseAndRank(rawChannels, request);
  const selectedKeys = new Set(candidates.map(recordIdentity));
  const frozenChannels = Object.freeze(Object.fromEntries(channelNames.map((channel) => [
    channel,
    Object.freeze(rawChannels[channel].filter((candidate) => selectedKeys.has(
      recordIdentity(candidate),
    )).map((candidate, index) => Object.freeze({ ...candidate, rank: index + 1 }))),
  ])));
  const preferred = new Set(request.search.preferredRecordIds.map((id) => id.toLocaleLowerCase()));
  const comparison = candidates.length > 1 && (
    preferred.size > 1 || candidates.every((candidate) => explicitlyNamed(candidate, request.search))
  );
  const reservedRecords = candidates.filter((candidate) => (
    preferred.has(candidate.recordId.toLocaleLowerCase()) || comparison
  )).map((candidate) => reservationFor(candidate, comparison
    ? (preferred.size > 1 ? 'contextual_comparison' : 'explicit_comparison')
    : 'canonical_memory'));
  return Object.freeze({
    version: TEMPLATE_ENGINE_HYBRID_RETRIEVAL_VERSION,
    query: request.search,
    scope: request.scope,
    executionMode: 'parallel',
    channels: frozenChannels,
    rawChannelCounts: Object.freeze(Object.fromEntries(channelNames.map((channel) => [
      channel, rawChannels[channel].length,
    ]))),
    failures: Object.freeze(failures),
    queryContext: Object.freeze({
      query: request.search.query,
      requestedFact: request.search.requestedFact,
      contextualReference: request.search.contextualReference,
      reservedRecords: Object.freeze(reservedRecords),
    }),
    candidates,
  });
}
