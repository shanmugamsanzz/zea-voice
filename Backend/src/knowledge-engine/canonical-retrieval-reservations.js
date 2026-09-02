import { typedRecordIdentityKey } from './canonical-record-identity.js';

export const CANONICAL_RETRIEVAL_RESERVATIONS_VERSION = 7;

const mandatoryReservationReasons = new Set([
  'explicit_current_entity',
  'explicit_entity',
  'explicit_comparison',
  'contextual_comparison',
  'canonical_memory',
  'category_unique_child',
  'applicable_workflow',
  'authorized_workflow',
]);

export function isMandatoryCanonicalReservation(value = {}) {
  const reason = normalized(value.reason);
  if (!mandatoryReservationReasons.has(reason)) return false;
  return !['applicable_workflow', 'authorized_workflow'].includes(reason)
    || String(value.recordType ?? '').trim().toUpperCase() === 'WORKFLOW_RULE';
}

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
  const publishedCategory = (value) => {
    const categoryKey = normalized(value?.categoryKey);
    if (!categoryKey) return value;
    return (resolution.namespaceCandidates?.CATALOG ?? []).find((candidate) => (
      String(candidate?.recordType ?? '').toUpperCase() === 'CATALOG_CATEGORY'
      && String(candidate?.entityType ?? '').toUpperCase() === 'ROUTE'
      && normalized(candidate?.categoryKey) === categoryKey
    )) ?? value;
  };
  const finalCandidate = resolution.candidate ?? null;
  const finalCandidateId = normalized(finalCandidate?.recordId);
  const highConfidence = Number(resolution.confidenceConfiguration?.highConfidence ?? 0.86);
  const finalStrongExplicit = (finalCandidate?.signals ?? []).some((signal) => (
    signal?.explicit === true
    && ['exact', 'normalized', 'tenant_alias', 'stt', 'phonetic'].includes(
      normalized(signal.method),
    )
    && Number(signal.score ?? 0) >= highConfidence
  ));
  const semanticReplacement = Boolean(finalCandidateId)
    && String(finalCandidate?.method ?? '').toLocaleLowerCase() === 'semantic'
    && !finalStrongExplicit;
  const survivesFinalResolution = (value) => !semanticReplacement
    || normalized(value?.recordId) === finalCandidateId
    || (String(value?.recordType ?? '').toUpperCase() === 'CATALOG_CATEGORY'
      && normalized(value?.categoryKey) === normalized(finalCandidate?.categoryKey));
  const explicitEntities = (understanding.explicitEntities ?? [])
    .filter(survivesFinalResolution);
  const explicitCategories = (understanding.explicitCategories ?? [])
    .map(publishedCategory).filter(survivesFinalResolution);
  const explicit = [
    ...explicitEntities,
    ...explicitCategories,
    ...(explicitEntities.length > 0 || explicitCategories.length > 0
      || semanticReplacement ? [] : [
      ...(understanding.ambiguity?.detected === true
        ? understanding.ambiguity.candidates ?? [] : []),
      understanding.confirmationCandidate,
    ]),
  ].map((value) => compact(value, 'explicit_entity')).filter(Boolean);
  if (!explicit.length && finalStrongExplicit) {
    const resolved = compact(resolution.candidate, 'explicit_entity');
    if (resolved) explicit.push(resolved);
  }
  const comparisonReason = understanding.comparisonContextSource === 'temporary_call_state'
    ? 'contextual_comparison' : 'explicit_comparison';
  const comparisons = (understanding.comparisonEntities ?? [])
    .map((value) => compact(value, comparisonReason)).filter(Boolean);
  if (classification.intentClass === 'COMPARISON_COMPLEX') {
    for (const candidate of resolution.namespaceCandidates?.CATALOG
      ?? resolution.routingCandidates ?? []) {
      if (candidate?.explicit !== true) continue;
      const selected = compact(candidate, 'explicit_comparison');
      if (selected) comparisons.push(selected);
    }
  }
  const contextDependent = understanding.contextDependent === true
    || resolution.contextDependent === true;
  const memory = request.input?.canonicalCallMemory ?? request.input?.memory ?? {};
  const activeMemory = memory.activeEntity
    ? compact(memory.activeEntity, 'canonical_memory')
    : compact(memory.activeCategory, 'canonical_memory', 'CATALOG_CATEGORY');
  const remembered = explicit.length || !contextDependent ? []
    : [activeMemory].filter(Boolean);
  const existing = retrieval?.queryContext?.reservedRecords
    ?? request.queryContext?.reservedRecords ?? [];
  const actionRequested = classification.intentClass === 'ACTION_TOOL_REQUEST'
    || understanding.actionIntent?.detected === true
    || Boolean(memory.activeTool?.name ?? memory.activeToolRequest?.name);
  const workflowCandidate = actionRequested
    && String(classification.candidate?.recordType ?? '').toUpperCase() === 'WORKFLOW_RULE'
    ? compact(classification.candidate, 'authorized_workflow', 'WORKFLOW_RULE') : null;
  const applicableWorkflow = !actionRequested
    && String(understanding.currentRouteSignal?.recordType ?? '').toUpperCase() === 'WORKFLOW_RULE'
    ? compact(understanding.currentRouteSignal, 'applicable_workflow', 'WORKFLOW_RULE') : null;
  const categoryChildren = existing.filter((entry) => (
    normalized(entry.reason) === 'category_unique_child'
    && String(entry.recordType ?? '').toUpperCase() === 'CATALOG_ITEM'
  )).map((entry) => compact(entry, 'category_unique_child')).filter(Boolean);
  const activeWorkflows = actionRequested ? existing.filter((entry) => (
    normalized(entry.reason) === 'authorized_workflow'
    && String(entry.recordType ?? '').toUpperCase() === 'WORKFLOW_RULE'
  )).map((entry) => compact(entry, 'authorized_workflow', 'WORKFLOW_RULE')).filter(Boolean) : [];
  const ordered = classification.intentClass === 'COMPARISON_COMPLEX'
    ? [...comparisons, ...explicit]
    : [...explicit, ...categoryChildren, ...comparisons, ...remembered,
      ...activeWorkflows, workflowCandidate, applicableWorkflow].filter(Boolean);
  return Object.freeze([...new Map(ordered.map((entry) => (
    [reservationKey(entry), Object.freeze({ ...entry })]
  ))).values()].slice(0, 5));
}
