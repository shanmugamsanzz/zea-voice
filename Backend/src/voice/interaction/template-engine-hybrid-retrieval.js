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
        aggregate.channelRanks[channel] = candidate.rank;
        aggregate.providerScores[channel] = candidate.providerScore;
        aggregate.reciprocalRankScore += 1 / (reciprocalRankConstant + candidate.rank);
      }
      byIdentity.set(key, aggregate);
    }
  }
  return Object.freeze([...byIdentity.values()].map((aggregate) => {
    const preferredRecord = preferred.has(aggregate.candidate.recordId.toLocaleLowerCase());
    return Object.freeze({
      ...aggregate.candidate,
      channels: Object.freeze(Object.keys(aggregate.channelRanks)),
      channelRanks: Object.freeze(aggregate.channelRanks),
      providerScores: Object.freeze(aggregate.providerScores),
      preferredRecord,
      score: aggregate.reciprocalRankScore + (preferredRecord ? 0.02 : 0),
    });
  }).sort((left, right) => (
    right.score - left.score
    || right.channels.length - left.channels.length
    || left.recordId.localeCompare(right.recordId)
  )).slice(0, request.candidateLimit));
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
  const frozenChannels = Object.freeze(channels);
  return Object.freeze({
    version: TEMPLATE_ENGINE_HYBRID_RETRIEVAL_VERSION,
    query: request.search,
    scope: request.scope,
    executionMode: 'parallel',
    channels: frozenChannels,
    failures: Object.freeze(failures),
    candidates: fuseAndRank(frozenChannels, request),
  });
}
