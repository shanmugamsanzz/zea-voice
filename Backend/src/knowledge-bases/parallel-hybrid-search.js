import { knowledgeSearchIndexes } from '../knowledge-engine/query-classifier.js';
import { retrieveTargetedCandidates } from '../knowledge-engine/targeted-retrieval.js';
import { collectCanonicalRetrievalReservations } from '../knowledge-engine/canonical-retrieval-reservations.js';
import {
  canonicalRecordIdentity,
  canonicalRecordIdentityKey,
} from '../knowledge-engine/canonical-record-identity.js';
import {
  publishedRecordCallerFacingHint,
} from '../knowledge-engine/evidence-audience.js';
import {
  buildPublicationDeduplicationIdentity,
} from '../knowledge-engine/publication-deduplication.js';

export const PARALLEL_HYBRID_SEARCH_VERSION = 4;

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

function scopedPublicationRecord(reservation, bundles = [], input = {}) {
  const tenantId = normalized(input.tenantId);
  const agentId = normalized(input.agentId);
  const usageDirection = normalized(input.usageDirection);
  for (const bundle of bundles) {
    const assignedAgentIds = (bundle?.assignedAgentIds ?? [])
      .map(normalized).filter(Boolean);
    const expectedRevision = Number(reservation.publicationRevision);
    if (normalized(bundle?.tenantId) !== tenantId
      || (assignedAgentIds.length && !assignedAgentIds.includes(agentId))
      || (reservation.tenantId && normalized(reservation.tenantId) !== tenantId)
      || (reservation.agentId && normalized(reservation.agentId) !== agentId)
      || (reservation.knowledgeBaseId
        && normalized(reservation.knowledgeBaseId) !== normalized(bundle.knowledgeBaseId))
      || (Number.isInteger(expectedRevision)
        && expectedRevision !== Number(bundle.publicationRevision))) continue;
    const record = (bundle?.records ?? []).find((candidate) => (
      normalized(candidate.record_id ?? candidate.recordId ?? candidate.id)
        === normalized(reservation.recordId)
      && String(candidate.record_type ?? candidate.recordType ?? candidate.type ?? '')
        .trim().toUpperCase() === String(reservation.recordType).trim().toUpperCase()
      && ['both', usageDirection].includes(normalized(
        candidate.usage_direction ?? candidate.usageDirection ?? 'both',
      ))
    ));
    if (!record) continue;
    const candidate = {
      tenantId: bundle.tenantId,
      agentId: input.agentId,
      recordId: reservation.recordId,
      recordType: reservation.recordType,
      namespace: namespaceByType[reservation.recordType] ?? null,
      knowledgeBaseId: String(bundle.knowledgeBaseId),
      publicationRevision: Number(bundle.publicationRevision),
      deduplicationIdentity: buildPublicationDeduplicationIdentity(record, {
        tenantId: bundle.tenantId,
        knowledgeBaseId: bundle.knowledgeBaseId,
        publicationRevision: bundle.publicationRevision,
      }),
      callerFacingHint: publishedRecordCallerFacingHint(record),
    };
    const canonicalIdentity = canonicalRecordIdentity(candidate);
    return Object.freeze({
      ...candidate,
      canonicalIdentity,
      canonicalIdentityKey: canonicalRecordIdentityKey(candidate),
      channel: 'structured', rank: 1, score: 1,
      matchMethod: reservation.reason,
      ...(reservation.categoryKey ? { categoryKey: reservation.categoryKey } : {}),
    });
  }
  return null;
}

function reserveBeforeFusion(result, request) {
  const reservedRecords = collectCanonicalRetrievalReservations(request, result);
  const reservedCandidates = reservedRecords
    .map((entry) => scopedPublicationRecord(
      entry, request.publicationBundles, request.input,
    )).filter(Boolean);
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
  const required = collectCanonicalRetrievalReservations(request);
  const signalled = new Set([
    String(classification.selectedNamespace ?? '').trim().toUpperCase(),
    candidateNamespace(classification.candidate),
    candidateNamespace(request.resolution?.candidate),
    ...required.map(candidateNamespace),
  ].filter((namespace) => namespaceIndexes[namespace]));
  for (const namespace of signalled) planned.add(namespace);
  // Classification is a search hint, not a gate. Search every published
  // namespace independently so an imperfect intent hint cannot hide the
  // caller-facing answer. Signalled namespaces retain the first positions.
  for (const namespace of allNamespaces) planned.add(namespace);
  return planned;
}

function primaryNamespacesForTurn(request = {}) {
  const classification = request.classification ?? {};
  return new Set([
    String(classification.selectedNamespace ?? '').trim().toUpperCase(),
    candidateNamespace(classification.candidate),
    candidateNamespace(request.resolution?.candidate),
    ...(classification.retrievalPlan?.indexes ?? []).map((index) => (
      Object.entries(namespaceIndexes).find(([, value]) => value === index)?.[0]
    )),
    ...collectCanonicalRetrievalReservations(request).map(candidateNamespace),
  ].filter((namespace) => namespaceIndexes[namespace]));
}

function forcedParallelClassification(request = {}) {
  const classification = request.classification ?? {};
  const relevantNamespaces = relevantNamespacesForTurn(request);
  const primaryNamespaces = primaryNamespacesForTurn(request);
  const indexes = new Set((classification.retrievalPlan?.indexes ?? []).filter((index) => (
    !Object.values(namespaceIndexes).includes(index)
  )));
  for (const namespace of relevantNamespaces) indexes.add(namespaceIndexes[namespace]);
  indexes.add(knowledgeSearchIndexes.BM25);
  indexes.add(knowledgeSearchIndexes.SEMANTIC);
  return Object.freeze({
    ...classification,
    relevantNamespaces: Object.freeze([...relevantNamespaces]),
    primaryNamespaces: Object.freeze([...primaryNamespaces]),
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
