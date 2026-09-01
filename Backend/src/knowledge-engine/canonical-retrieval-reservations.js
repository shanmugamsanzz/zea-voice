import { typedRecordIdentityKey } from './canonical-record-identity.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';

export const CANONICAL_RETRIEVAL_RESERVATIONS_VERSION = 3;

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function compact(value, reason, fallbackType = 'CATALOG_ITEM') {
  const recordId = String(value?.recordId ?? value?.id ?? '').trim();
  if (!recordId) return null;
  return Object.freeze({
    recordId,
    recordType: String(value?.recordType ?? (value?.entityType === 'CATEGORY'
      ? 'CATALOG_CATEGORY' : fallbackType)).trim().toUpperCase(),
    categoryKey: value?.categoryKey ?? null,
    tenantId: value?.tenantId ?? null,
    agentId: value?.agentId ?? null,
    knowledgeBaseId: value?.knowledgeBaseId ?? null,
    publicationRevision: Number.isInteger(Number(value?.publicationRevision))
      ? Number(value.publicationRevision) : null,
    reason,
  });
}

function reservationKey(value) {
  return typedRecordIdentityKey(value)
    ?? `${String(value?.recordType ?? '').toUpperCase()}:${normalized(value?.recordId)}`;
}

export function collectCanonicalRetrievalReservations(request = {}, retrieval = null) {
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
  ].map((value) => compact(value, 'explicit_entity')).filter(Boolean);
  if (!explicit.length && resolution.candidate?.explicit === true) {
    const resolved = compact(resolution.candidate, 'explicit_entity');
    if (resolved) explicit.push(resolved);
  }
  const comparisons = (understanding.comparisonEntities ?? [])
    .map((value) => compact(value, 'explicit_comparison')).filter(Boolean);
  const retrievedCandidates = Object.values(retrieval?.channels ?? {}).flat();
  const callerFacingConversation = (candidate) => candidate?.callerFacingHint === true
    || retrievedCandidates.some((retrieved) => (
      normalized(retrieved?.recordId) === normalized(candidate?.recordId)
      && String(retrieved?.recordType ?? '').toUpperCase() === 'CONVERSATION_NODE'
      && retrieved?.callerFacingHint === true
    ));
  if (classification.intentClass === 'COMPARISON_COMPLEX') {
    for (const candidate of resolution.namespaceCandidates?.CATALOG
      ?? resolution.routingCandidates ?? []) {
      if (candidate?.explicit !== true) continue;
      const selected = compact(candidate, 'explicit_comparison');
      if (selected) comparisons.push(selected);
    }
  }
  const overview = classification.intentClass === 'CATEGORY_OVERVIEW'
    ? [classification.candidate, ...(resolution.namespaceCandidates?.CONVERSATION ?? [])]
      .filter((candidate) => (
        String(candidate?.recordType ?? '').toUpperCase() === 'CONVERSATION_NODE'
        && String(candidate?.intentClass ?? '').toUpperCase() === 'CATEGORY_OVERVIEW'
        && callerFacingConversation(candidate)
      )).slice(0, 1)
      .map((value) => compact(value, 'published_overview', 'CONVERSATION_NODE'))
      .filter(Boolean)
    : [];
  const overviewCatalog = classification.intentClass === 'CATEGORY_OVERVIEW'
    ? [...new Map([
      ...(resolution.namespaceCandidates?.CATALOG ?? []),
      classification.candidate,
      resolution.candidate,
    ]
      .filter((candidate) => (
        String(candidate?.recordType ?? '').toUpperCase() === 'CATALOG_CATEGORY'
        && (candidate === resolution.candidate
          || candidate === classification.candidate || candidate?.explicit === true)
      ))
      // Prefer the resolved authoritative category route over a synthetic
      // category projection derived from one of its child Catalog items.
      .map((candidate) => [
        normalized(candidate?.categoryKey) || normalized(candidate?.recordId),
        candidate,
      ])).values()]
      .map((value) => compact(value, 'published_overview', 'CATALOG_CATEGORY'))
      .filter(Boolean)
    : [];
  const overviewCategoryKeys = new Set(overviewCatalog
    .map((entry) => normalized(entry.categoryKey)).filter(Boolean));
  const effectiveExplicit = classification.intentClass === 'CATEGORY_OVERVIEW'
    ? explicit.filter((entry) => (
      !overviewCategoryKeys.has(normalized(entry.categoryKey))
      || overviewCatalog.some((overviewEntry) => (
        normalized(overviewEntry.recordId) === normalized(entry.recordId)
      ))
    ))
    : explicit;
  const contextDependent = understanding.contextDependent === true
    || resolution.contextDependent === true;
  const memory = request.input?.canonicalCallMemory ?? request.input?.memory ?? {};
  const activeMemory = memory.activeEntity
    ? compact(memory.activeEntity, 'canonical_memory')
    : compact(memory.activeCategory, 'canonical_memory', 'CATALOG_CATEGORY');
  const remembered = explicit.length || !contextDependent ? []
    : [activeMemory].filter(Boolean);
  const confidence = resolveKnowledgeConfidenceConfiguration(
    classification.confidenceConfiguration ?? resolution.confidenceConfiguration,
  );
  const latestCandidate = classification.intentClass === 'CATEGORY_OVERVIEW'
    && String(resolution.candidate?.recordType ?? '').toUpperCase() === 'CATALOG_CATEGORY'
    ? resolution.candidate : classification.candidate;
  const latestCandidateType = String(latestCandidate?.recordType ?? '').toUpperCase();
  const latestRequest = latestCandidate?.recordId
    && (latestCandidate.explicit === true
      || Number(latestCandidate.score ?? 0) >= confidence.highConfidence)
    && (latestCandidateType !== 'WORKFLOW_RULE'
      || classification.intentClass === 'ACTION_TOOL_REQUEST')
    ? [compact(latestCandidate, 'latest_request_record')].filter(Boolean) : [];
  const useCase = request.input?.queryUnderstanding?.need?.detected === true
    ? (retrieval?.channels?.structured ?? []).find((candidate) => (
      candidate.matchMethod === 'published_use_case'
      && Number(candidate.score ?? 0) >= confidence.highConfidence
    )) : null;
  const useCaseReservations = useCase
    ? [compact(useCase, 'published_use_case')].filter(Boolean) : [];
  const existing = retrieval?.queryContext?.reservedRecords
    ?? request.queryContext?.reservedRecords ?? [];
  const ordered = classification.intentClass === 'COMPARISON_COMPLEX'
    ? [...comparisons, ...explicit, ...existing, ...remembered]
    : [...effectiveExplicit, ...overviewCatalog, ...overview, ...latestRequest,
      ...comparisons, ...remembered,
      ...useCaseReservations, ...existing];
  return Object.freeze([...new Map(ordered.map((entry) => (
    [reservationKey(entry), Object.freeze({ ...entry })]
  ))).values()].slice(0, 5));
}
