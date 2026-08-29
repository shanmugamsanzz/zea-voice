import { typedRecordIdentityKey } from './canonical-record-identity.js';
import { resolveKnowledgeConfidenceConfiguration } from '../knowledge-bases/knowledge-confidence-config.js';

export const CANONICAL_RETRIEVAL_RESERVATIONS_VERSION = 1;

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
      )).map((value) => compact(value, 'published_overview', 'CONVERSATION_NODE'))
      .filter(Boolean)
    : [];
  const contextDependent = understanding.contextDependent === true
    || resolution.contextDependent === true;
  const memory = request.input?.canonicalCallMemory ?? request.input?.memory ?? {};
  const activeMemory = memory.activeEntity
    ? compact(memory.activeEntity, 'canonical_memory')
    : compact(memory.activeCategory, 'canonical_memory', 'CATALOG_CATEGORY');
  const knownMemory = (memory.knownEntities ?? [])
    .map((entry) => compact(entry, 'canonical_memory')).filter(Boolean);
  const remembered = explicit.length || !contextDependent ? []
    : [activeMemory ?? (knownMemory.length === 1 ? knownMemory[0] : null)].filter(Boolean);
  const confidence = resolveKnowledgeConfidenceConfiguration(
    classification.confidenceConfiguration ?? resolution.confidenceConfiguration,
  );
  const latestCandidate = classification.candidate;
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
    : [...explicit, ...overview, ...latestRequest, ...comparisons, ...remembered,
      ...useCaseReservations, ...existing];
  return Object.freeze([...new Map(ordered.map((entry) => (
    [reservationKey(entry), Object.freeze({ ...entry })]
  ))).values()].slice(0, 5));
}
