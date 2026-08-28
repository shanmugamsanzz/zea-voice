import { knowledgeSearchIndexes } from '../knowledge-engine/query-classifier.js';
import { retrieveTargetedCandidates } from '../knowledge-engine/targeted-retrieval.js';
import { resolveKnowledgeConfidenceConfiguration } from './knowledge-confidence-config.js';

export const PARALLEL_HYBRID_SEARCH_VERSION = 1;

const namespaceByType = Object.freeze({
  CATALOG_ITEM: 'CATALOG', CATALOG_CATEGORY: 'CATALOG', FAQ: 'FAQ',
  CONVERSATION_NODE: 'CONVERSATION', WORKFLOW_RULE: 'WORKFLOW',
  KNOWLEDGE_CHUNK: 'GENERAL',
});

const namespaceIndexes = Object.freeze({
  CATALOG: knowledgeSearchIndexes.CATALOG,
  FAQ: knowledgeSearchIndexes.FAQ,
  CONVERSATION: knowledgeSearchIndexes.CONVERSATION,
  WORKFLOW: knowledgeSearchIndexes.WORKFLOW,
  GENERAL: knowledgeSearchIndexes.GENERAL,
});

const allNamespaces = Object.freeze(Object.keys(namespaceIndexes));

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function compactReservation(value, reason, fallbackType = 'CATALOG_ITEM') {
  const recordId = String(value?.recordId ?? value?.id ?? '').trim();
  if (!recordId) return null;
  return Object.freeze({
    recordId,
    recordType: String(value?.recordType ?? (value?.entityType === 'CATEGORY'
      ? 'CATALOG_CATEGORY' : fallbackType)).toUpperCase(),
    categoryKey: value?.categoryKey ?? null,
    reason,
  });
}

function requiredReservations(request) {
  const understanding = request.input?.queryUnderstanding ?? {};
  const classification = request.classification ?? {};
  const resolution = request.resolution ?? {};
  const explicit = [
    ...(understanding.explicitEntities ?? []),
    ...(understanding.explicitCategories ?? []),
    ...((understanding.explicitEntities?.length ?? 0) > 0
      || (understanding.explicitCategories?.length ?? 0) > 0 ? [] : [
      ...(understanding.ambiguity?.detected === true
        ? understanding.ambiguity.candidates ?? [] : []),
      understanding.confirmationCandidate,
    ]),
  ].map((value) => compactReservation(value, 'explicit_entity')).filter(Boolean);
  if (!explicit.length && resolution.candidate?.explicit === true) {
    const resolved = compactReservation(resolution.candidate, 'explicit_entity');
    if (resolved) explicit.push(resolved);
  }
  const comparisons = (understanding.comparisonEntities ?? [])
    .map((value) => compactReservation(value, 'explicit_comparison')).filter(Boolean);
  const overview = classification.intentClass === 'CATEGORY_OVERVIEW'
    ? [classification.candidate, ...(resolution.namespaceCandidates?.CONVERSATION ?? [])]
      .filter((candidate) => (
        String(candidate?.recordType ?? '').toUpperCase() === 'CONVERSATION_NODE'
        && String(candidate?.intentClass ?? '').toUpperCase() === 'CATEGORY_OVERVIEW'
      )).map((value) => compactReservation(value, 'published_overview', 'CONVERSATION_NODE'))
      .filter(Boolean)
    : [];
  const contextDependent = understanding.contextDependent === true
    || resolution.contextDependent === true;
  const memory = request.input?.canonicalCallMemory ?? request.input?.memory ?? {};
  const activeMemory = memory.activeEntity
    ? compactReservation(memory.activeEntity, 'canonical_memory')
    : compactReservation(memory.activeCategory, 'canonical_memory', 'CATALOG_CATEGORY');
  const knownMemory = (memory.knownEntities ?? [])
    .map((entry) => compactReservation(entry, 'canonical_memory')).filter(Boolean);
  const remembered = explicit.length || !contextDependent ? []
    : [activeMemory ?? (knownMemory.length === 1 ? knownMemory[0] : null)].filter(Boolean);
  const ordered = classification.intentClass === 'COMPARISON_COMPLEX'
    ? [...comparisons, ...explicit] : [...explicit, ...overview, ...comparisons, ...remembered];
  return Object.freeze([...new Map(ordered.map((entry) => (
    [`${entry.recordType}:${normalized(entry.recordId)}`, entry]
  ))).values()].slice(0, 5));
}

function scopedPublicationRecord(reservation, bundles = []) {
  for (const bundle of bundles) {
    const record = (bundle?.records ?? []).find((candidate) => normalized(
      candidate.record_id ?? candidate.recordId ?? candidate.id,
    ) === normalized(reservation.recordId));
    if (!record) continue;
    return Object.freeze({
      recordId: reservation.recordId,
      recordType: reservation.recordType,
      knowledgeBaseId: String(bundle.knowledgeBaseId),
      publicationRevision: Number(bundle.publicationRevision),
      channel: 'structured', rank: 1, score: 1,
      matchMethod: reservation.reason,
      ...(reservation.categoryKey ? { categoryKey: reservation.categoryKey } : {}),
    });
  }
  return null;
}

function reserveBeforeFusion(result, request) {
  const requested = requiredReservations(request);
  const confidence = resolveKnowledgeConfidenceConfiguration(
    request.classification?.confidenceConfiguration
      ?? request.resolution?.confidenceConfiguration,
  );
  const useCaseReservation = request.input?.queryUnderstanding?.need?.detected === true
    ? (result.channels?.structured ?? []).find((candidate) => (
      candidate.matchMethod === 'published_use_case'
      && Number(candidate.score ?? 0) >= confidence.highConfidence
    ))
    : null;
  const needReserved = useCaseReservation
    ? [compactReservation(useCaseReservation, 'published_use_case')]
      .filter(Boolean)
    : [];
  const existing = result.queryContext?.reservedRecords ?? [];
  const reservedRecords = Object.freeze([...new Map([
    ...requested, ...needReserved, ...existing,
  ].map((entry) => (
    [`${String(entry.recordType).toUpperCase()}:${normalized(entry.recordId)}`, entry]
  ))).values()].slice(0, 5));
  const reservedCandidates = reservedRecords
    .map((entry) => scopedPublicationRecord(entry, request.publicationBundles)).filter(Boolean);
  const structured = Object.freeze([...new Map([
    ...reservedCandidates, ...(result.channels?.structured ?? []),
  ].map((candidate) => (
    [`${String(candidate.recordType).toUpperCase()}:${normalized(candidate.recordId)}`, candidate]
  ))).values()].slice(0, request.limitPerChannel ?? 12).map((candidate, index) => Object.freeze({
    ...candidate, channel: 'structured', rank: index + 1,
  })));
  const channels = Object.freeze({ ...result.channels, structured });
  const namespaceChannels = Object.freeze(Object.fromEntries(
    Object.entries(channels).map(([channel, candidates]) => [channel, Object.freeze(
      Object.fromEntries(['CATALOG', 'FAQ', 'CONVERSATION', 'WORKFLOW', 'GENERAL']
        .map((namespace) => [namespace, Object.freeze(candidates.filter((candidate) => (
          namespaceByType[candidate.recordType] === namespace
        )))])),
    )]),
  ));
  return Object.freeze({
    ...result,
    queryContext: Object.freeze({ ...(result.queryContext ?? {}), reservedRecords }),
    channels,
    namespaceChannels,
    candidateCount: Object.values(channels).reduce((sum, candidates) => sum + candidates.length, 0),
  });
}

function candidateNamespace(value) {
  const direct = String(value?.namespace ?? '').trim().toUpperCase();
  if (namespaceIndexes[direct]) return direct;
  return namespaceByType[String(value?.recordType ?? '').trim().toUpperCase()] ?? null;
}

function relevantNamespacesForTurn(request = {}) {
  const classification = request.classification ?? {};
  const planned = new Set((classification.retrievalPlan?.indexes ?? []).map((index) => (
    Object.entries(namespaceIndexes).find(([, value]) => value === index)?.[0]
  )).filter(Boolean));
  const required = requiredReservations(request);
  const signalled = new Set([
    String(classification.selectedNamespace ?? '').trim().toUpperCase(),
    candidateNamespace(classification.candidate),
    candidateNamespace(request.resolution?.candidate),
    ...required.map(candidateNamespace),
  ].filter((namespace) => namespaceIndexes[namespace]));
  const intentClass = String(classification.intentClass ?? 'UNKNOWN').toUpperCase();
  if (intentClass === 'UNKNOWN' && signalled.size > 0) return signalled;
  for (const namespace of signalled) planned.add(namespace);
  if (planned.size > 0) return planned;
  return new Set(allNamespaces);
}

function forcedParallelClassification(request = {}) {
  const classification = request.classification ?? {};
  const relevantNamespaces = relevantNamespacesForTurn(request);
  const indexes = new Set((classification.retrievalPlan?.indexes ?? []).filter((index) => (
    !Object.values(namespaceIndexes).includes(index)
  )));
  for (const namespace of relevantNamespaces) indexes.add(namespaceIndexes[namespace]);
  indexes.add(knowledgeSearchIndexes.BM25);
  indexes.add(knowledgeSearchIndexes.SEMANTIC);
  return Object.freeze({
    ...classification,
    relevantNamespaces: Object.freeze([...relevantNamespaces]),
    retrievalPlan: Object.freeze({
      ...(classification.retrievalPlan ?? {}),
      indexes: Object.freeze([...indexes]),
      parallelChannels: Object.freeze(['structured', 'bm25', 'qdrant']),
    }),
  });
}

export async function searchParallelHybridCandidates(request = {}, dependencies = {}) {
  const classification = forcedParallelClassification(request);
  const result = await retrieveTargetedCandidates({
    ...request,
    classification,
  }, dependencies);
  const reservedResult = reserveBeforeFusion(result, { ...request, classification });
  const channels = reservedResult.channels ?? {};
  for (const channel of ['structured', 'bm25', 'qdrant']) {
    if (!Array.isArray(channels[channel])) {
      throw new TypeError(`Parallel hybrid search did not return the ${channel} channel`);
    }
  }
  return Object.freeze({
    ...reservedResult,
    version: PARALLEL_HYBRID_SEARCH_VERSION,
    executionMode: 'parallel_hybrid',
    classification,
  });
}
