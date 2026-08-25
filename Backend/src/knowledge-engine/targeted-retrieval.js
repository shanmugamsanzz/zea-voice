import { embedQuery } from '../rag/embedding.client.js';
import { searchTenantPoints } from '../rag/qdrant.client.js';
import { knowledgeSearchIndexes } from './query-classifier.js';

export const TARGETED_RETRIEVAL_VERSION = 2;

const documentIndexTypes = Object.freeze({
  [knowledgeSearchIndexes.CATALOG]: 'CATALOG_ITEM',
  [knowledgeSearchIndexes.FAQ]: 'FAQ',
  [knowledgeSearchIndexes.CONVERSATION]: 'CONVERSATION_NODE',
  [knowledgeSearchIndexes.WORKFLOW]: 'WORKFLOW_RULE',
  [knowledgeSearchIndexes.GENERAL]: 'KNOWLEDGE_CHUNK',
});

const defaultDependencies = Object.freeze({ embed: embedQuery, search: searchTenantPoints });

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
      records.set(normalizeId(recordId), Object.freeze({
        recordId,
        recordType: String(record.record_type ?? record.recordType ?? record.type ?? '').toUpperCase(),
        knowledgeBaseId,
        publicationRevision,
        itemKey: String(record.entity_metadata?.itemKey ?? record.metadata?.itemKey ?? '').trim() || null,
        categoryKey: String(record.entity_metadata?.categoryKey ?? record.metadata?.categoryKey ?? '').trim() || null,
      }));
    }
  }
  return { scope: Object.freeze(scope), records };
}

function freezeCandidate(candidate, channel, rank) {
  return Object.freeze({
    recordId: String(candidate.recordId),
    recordType: String(candidate.recordType).toUpperCase(),
    knowledgeBaseId: String(candidate.knowledgeBaseId),
    publicationRevision: Number(candidate.publicationRevision),
    channel,
    rank,
    score: boundedScore(candidate.score),
    ...(candidate.tokenCoverage === undefined
      ? {} : { tokenCoverage: boundedScore(candidate.tokenCoverage) }),
    ...(candidate.matchMethod ? { matchMethod: String(candidate.matchMethod) } : {}),
    ...(candidate.categoryKey ? { categoryKey: String(candidate.categoryKey) } : {}),
    ...(Array.isArray(candidate.evidenceRecordIds)
      ? { evidenceRecordIds: Object.freeze([...candidate.evidenceRecordIds]) } : {}),
  });
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
  if (!allowedTypes.has('CATALOG_ITEM')) return null;
  const active = input?.memory?.activeEntity;
  if (!active) return null;
  const recordId = normalizeId(active.recordId ?? active.id);
  const direct = recordId ? recordScope.get(recordId) : null;
  if (direct?.recordType === 'CATALOG_ITEM') return direct;
  const itemKey = normalizeId(active.itemKey ?? active.key);
  if (!itemKey) return null;
  return [...recordScope.values()].find((record) => record.recordType === 'CATALOG_ITEM'
    && normalizeId(record.itemKey) === itemKey) ?? null;
}

function activeWorkflowCandidate(input, recordScope, allowedTypes) {
  if (!allowedTypes.has('WORKFLOW_RULE')) return null;
  const active = input?.memory?.activeTool;
  if (!active) return null;
  const recordId = normalizeId(active.authorizationRecordId
    ?? active.authorizationEvidenceId ?? active.workflowRecordId);
  const direct = recordId ? recordScope.get(recordId) : null;
  return direct?.recordType === 'WORKFLOW_RULE' ? direct : null;
}

function structuredCandidatesForTurn(input, classification, resolution, recordScope, allowedTypes, limit) {
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
  if (classification?.intentClass === 'ACTION_TOOL_REQUEST') {
    const explicitCatalog = (resolution?.namespaceCandidates?.CATALOG ?? []).filter((candidate) => (
      candidate.explicit === true && Number(candidate.score ?? 0) >= 0.88
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
  if (resolution?.contextDependent === true) {
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
  return Object.freeze(candidates.slice(0, limit));
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

function bm25Candidates(input, sparseIndexes, scope, allowedTypes, limit) {
  const queryTokens = [...new Set(tokens(input.utterance))];
  if (!queryTokens.length) return Object.freeze([]);
  const documents = validSparseDocuments(sparseIndexes, input, scope, allowedTypes);
  if (!documents.length) return Object.freeze([]);
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
      recordId: document.id,
      recordType: document.recordType,
      knowledgeBaseId: document.knowledgeBaseId,
      publicationRevision: document.publicationRevision,
      score,
      tokenCoverage: matched / queryTokens.length,
    }];
  });
  return rankChannel(ranked, 'bm25', limit);
}

function semanticPayloadCandidate(match, scope, input, allowedTypes) {
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
  return recordId ? {
    recordId, recordType, knowledgeBaseId, publicationRevision, score: boundedScore(match.score),
  } : null;
}

async function semanticCandidates(input, scope, allowedTypes, limit, dependencies) {
  if (!scope.length || input.abortSignal?.aborted) return Object.freeze([]);
  const vector = await dependencies.embed(input.utterance, { signal: input.abortSignal });
  const matches = await dependencies.search(input.tenantId, vector, {
    knowledgeBases: scope,
    usageDirection: input.usageDirection,
    agentId: input.agentId,
    abortSignal: input.abortSignal,
    limit,
    scoreThreshold: 0,
    recordTypes: [...allowedTypes],
  });
  return rankChannel((matches ?? []).map(
    (match) => semanticPayloadCandidate(match, scope, input, allowedTypes),
  ).filter(Boolean), 'qdrant', limit);
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

  const structuredPromise = Promise.resolve().then(() => {
    dependencies.onChannelStart?.('structured');
    return structuredCandidatesForTurn(
      input, classification, resolution, records, recordTypes, limitPerChannel,
    );
  });
  const bm25Promise = indexes.has(knowledgeSearchIndexes.BM25)
    ? Promise.resolve().then(() => {
      dependencies.onChannelStart?.('bm25');
      return bm25Candidates(input, sparseIndexes, scope, recordTypes, limitPerChannel);
    })
    : Promise.resolve(Object.freeze([]));
  const qdrantPromise = indexes.has(knowledgeSearchIndexes.SEMANTIC)
    ? Promise.resolve().then(() => {
      dependencies.onChannelStart?.('qdrant');
      return semanticCandidates(input, scope, recordTypes, limitPerChannel, dependencies);
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
    channels: Object.freeze({ structured, bm25, qdrant }),
    candidateCount: structured.length + bm25.length + qdrant.length,
  });
}
