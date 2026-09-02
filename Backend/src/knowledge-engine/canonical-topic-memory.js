export const CANONICAL_TOPIC_MEMORY_VERSION = 5;

const catalogTypes = new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']);

function clean(value, maximum = 240) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalized(value) {
  return clean(value, 200).toLocaleLowerCase();
}

function revision(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function scoped(scope = {}) {
  const result = Object.freeze({
    tenantId: clean(scope.tenantId, 160),
    agentId: clean(scope.agentId, 160),
    callId: clean(scope.callId, 160),
  });
  if (!result.tenantId || !result.agentId || !result.callId) {
    throw new TypeError('Canonical topic resolution requires tenant, agent and call scope');
  }
  return result;
}

/**
 * Normalizes the only Catalog identity shape that may be persisted as active
 * call memory. Display text is deliberately insufficient: a remembered topic
 * must point back to one tenant-published PostgreSQL record and revision.
 */
export function normalizeCanonicalRecordMemory(value = {}, {
  scope = {}, expectedRecordType = null,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const recordType = clean(value.recordType, 80).toLocaleUpperCase();
  if (!catalogTypes.has(recordType)
    || (expectedRecordType && recordType !== String(expectedRecordType).toLocaleUpperCase())) return null;
  const tenantId = clean(value.tenantId ?? scope.tenantId, 160);
  const knowledgeBaseId = clean(value.knowledgeBaseId, 160);
  const publicationRevision = revision(value.publicationRevision);
  const recordId = clean(value.recordId ?? value.id, 160);
  const category = recordType === 'CATALOG_CATEGORY';
  const itemKey = category ? null : clean(value.itemKey ?? value.key, 160);
  const categoryKey = clean(value.categoryKey ?? (category ? value.key : null), 160);
  const canonicalName = clean(
    value.canonicalName ?? value.name ?? (category ? value.category : null), 240,
  );
  if (!tenantId || !knowledgeBaseId || publicationRevision === null || !recordId
    || !canonicalName || (category ? !categoryKey : !itemKey)) return null;
  if (scope.tenantId && normalized(tenantId) !== normalized(scope.tenantId)) return null;
  return Object.freeze({
    tenantId,
    knowledgeBaseId,
    publicationRevision,
    recordType,
    recordId,
    ...(itemKey ? { itemKey } : {}),
    ...(categoryKey ? { categoryKey } : {}),
    canonicalName,
    id: recordId,
    entityType: category ? 'CATEGORY' : 'ITEM',
    key: category ? categoryKey : itemKey,
    name: canonicalName,
    category: clean(value.category, 240) || (category ? canonicalName : null),
    agentId: clean(value.agentId ?? scope.agentId, 160) || null,
  });
}

function cleanRetrievalMemory(memory = {}) {
  return {
    ...memory,
    knownEntities: Object.freeze([...(memory.knownEntities ?? [])]),
    comparisonEntities: Object.freeze([...(memory.comparisonEntities ?? [])]),
  };
}

/**
 * Creates the transaction-local canonical state used by retrieval. It never
 * writes ranked/search candidates into durable call memory. Durable state is
 * still committed only after the grounded decision selects hydrated evidence.
 */
export function prepareCanonicalRetrievalMemory({
  scope, memory = {}, understanding = {},
} = {}) {
  const isolatedScope = scoped(scope);
  const next = cleanRetrievalMemory(memory);
  const normalizedCandidates = (values, expectedRecordType) => (values ?? [])
    .map((value) => normalizeCanonicalRecordMemory(value, {
      scope: isolatedScope, expectedRecordType,
    })).filter(Boolean);
  const ambiguous = understanding.ambiguity?.detected === true;
  const comparison = normalizedCandidates(
    understanding.comparisonEntities, 'CATALOG_ITEM',
  );
  const explicitItems = normalizedCandidates(
    understanding.explicitEntities, 'CATALOG_ITEM',
  );
  const explicitCategories = normalizedCandidates(
    understanding.explicitCategories, 'CATALOG_CATEGORY',
  );
  const explicit = [...explicitItems, ...explicitCategories];
  let mode = 'CLEARED_STALE_CONTEXT';

  if (!ambiguous && comparison.length > 1) {
    next.activeEntity = null;
    next.activeCategory = null;
    next.knownEntities = Object.freeze([...comparison]);
    next.comparisonEntities = Object.freeze([...comparison]);
    next.pendingQuestion = null;
    next.pendingClarification = null;
    mode = 'EXPLICIT_COMPARISON';
  } else if (!ambiguous && explicit.length === 1) {
    const selected = explicit[0];
    const previous = normalizeCanonicalRecordMemory(
      memory.activeEntity ?? memory.activeCategory, { scope: isolatedScope },
    );
    next.activeEntity = selected.recordType === 'CATALOG_ITEM' ? selected : null;
    next.activeCategory = selected.recordType === 'CATALOG_CATEGORY' ? selected : null;
    next.knownEntities = selected.recordType === 'CATALOG_ITEM'
      ? Object.freeze([selected]) : Object.freeze([]);
    next.comparisonEntities = Object.freeze([]);
    next.currentTopic = selected.canonicalName;
    next.pendingQuestion = null;
    next.pendingClarification = null;
    if (previous && normalized(previous.recordId) !== normalized(selected.recordId)) {
      next.activeTool = null;
      next.activeToolRequest = null;
      next.collectedToolFields = Object.freeze({});
      next.collectedInformation = Object.freeze({});
    }
    mode = previous && normalized(previous.recordId) !== normalized(selected.recordId)
      ? 'EXPLICIT_REPLACEMENT' : 'EXPLICIT_SELECTION';
  } else if (!ambiguous && understanding.contextDependent === true) {
    const remembered = normalizeCanonicalRecordMemory(
      memory.activeEntity ?? memory.activeCategory, { scope: isolatedScope },
    );
    if (remembered) {
      next.activeEntity = remembered.recordType === 'CATALOG_ITEM' ? remembered : null;
      next.activeCategory = remembered.recordType === 'CATALOG_CATEGORY' ? remembered : null;
      next.knownEntities = remembered.recordType === 'CATALOG_ITEM'
        ? Object.freeze([remembered]) : Object.freeze([]);
      next.comparisonEntities = Object.freeze([]);
      next.currentTopic = remembered.canonicalName;
      mode = 'CONTEXTUAL_REUSE';
    }
  }

  if (mode === 'CLEARED_STALE_CONTEXT') {
    next.activeEntity = null;
    next.activeCategory = null;
    next.knownEntities = Object.freeze([]);
    next.comparisonEntities = Object.freeze([]);
    next.currentTopic = null;
    if (ambiguous || explicit.length > 1) {
      next.pendingQuestion = null;
      next.pendingClarification = null;
      mode = 'AMBIGUOUS_CURRENT_SELECTION';
    }
  }

  return Object.freeze({
    version: CANONICAL_TOPIC_MEMORY_VERSION,
    scope: isolatedScope,
    mode,
    memory: Object.freeze(next),
  });
}

function canonicalRecord(source, scope) {
  if (source?.tenantId && normalized(source.tenantId) !== normalized(scope.tenantId)) return null;
  if (source?.agentId && normalized(source.agentId) !== normalized(scope.agentId)) return null;
  if (!source || source.hydrationValidated !== true || source.publicationValidated !== true
    || !catalogTypes.has(String(source.recordType ?? '').toLocaleUpperCase())) return null;
  const data = source.authoritativeData ?? {};
  const category = String(source.recordType).toLocaleUpperCase() === 'CATALOG_CATEGORY';
  const recordId = clean(source.recordId, 160);
  const key = clean(category ? data.categoryKey : data.itemKey, 160);
  const name = clean(category ? data.category : data.name, 240);
  if (!recordId || !key || !name) return null;
  return normalizeCanonicalRecordMemory({
    tenantId: source.tenantId ?? scope.tenantId,
    agentId: source.agentId ?? scope.agentId,
    knowledgeBaseId: source.knowledgeBaseId,
    publicationRevision: source.publicationRevision,
    recordType: category ? 'CATALOG_CATEGORY' : 'CATALOG_ITEM',
    recordId,
    itemKey: category ? null : key,
    categoryKey: clean(data.categoryKey, 160) || (category ? key : null),
    canonicalName: name,
    category: clean(data.category, 240) || null,
  }, { scope });
}

function unresolvedResolution(resolution, reason) {
  return Object.freeze({
    version: CANONICAL_TOPIC_MEMORY_VERSION,
    scope: resolution.scope,
    mode: 'UNRESOLVED',
    activeEntity: null,
    activeCategory: null,
    comparisonEntities: Object.freeze([]),
    requiresTargetedClarification: false,
    reason,
  });
}

/**
 * Confirms that a proposed memory change is backed by the same tenant-published
 * PostgreSQL records used for the validated turn. Retrieved alternatives never
 * become memory merely because they appeared in the top five.
 */
export function confirmCanonicalTopicResolution(resolution = {}, {
  decision = {}, hydratedRecords = [],
} = {}) {
  const mode = clean(resolution.mode, 40).toLocaleUpperCase();
  if (!['EXPLICIT', 'CONTEXTUAL', 'COMPARISON'].includes(mode)) {
    return unresolvedResolution(resolution, resolution.reason ?? 'canonical_selection_unconfirmed');
  }
  if (decision.valid !== true || String(decision.decision ?? '').toLocaleLowerCase() === 'clarify') {
    return unresolvedResolution(resolution, 'grounded_decision_did_not_confirm_entity');
  }
  const targets = mode === 'COMPARISON'
    ? resolution.comparisonEntities ?? []
    : [resolution.activeEntity ?? resolution.activeCategory].filter(Boolean);
  const structurallyValid = targets.length > 0 && targets.every((target) => {
    const recordType = clean(target?.recordType, 80).toLocaleUpperCase();
    if (mode === 'COMPARISON') return recordType === 'CATALOG_ITEM';
    if (target === resolution.activeEntity) return recordType === 'CATALOG_ITEM';
    return recordType === 'CATALOG_CATEGORY';
  });
  if (!structurallyValid) {
    return unresolvedResolution(resolution, 'canonical_entity_type_mismatch');
  }
  const byRecordId = new Map((Array.isArray(hydratedRecords) ? hydratedRecords : [])
    .filter((record) => record?.recordId)
    .map((record) => [normalized(record.recordId), record]));
  const selectedSourceIds = new Set((decision.evidenceIds ?? [])
    .map((sourceId) => normalized(sourceId)).filter(Boolean));
  const selectedEntityIdentities = new Set([
    ...(decision.selectedEntityKeys ?? []),
    ...(decision.stateUpdate?.knownEntityKeys ?? []),
    ...(decision.selectedEntities ?? []).flatMap((entity) => (
      [entity?.id, entity?.recordId, entity?.key, entity?.name]
    )),
    ...(decision.stateUpdate?.knownEntities ?? []).flatMap((entity) => (
      [entity?.id, entity?.recordId, entity?.key, entity?.name]
    )),
    decision.currentTopic,
    decision.stateUpdate?.currentTopic,
  ].map((value) => normalized(value)).filter(Boolean));
  const supported = targets.length > 0 && targets.every((target) => {
    const record = byRecordId.get(normalized(target.recordId ?? target.id));
    if (!record || record.hydrationValidated !== true || record.publicationValidated !== true) return false;
    if (clean(record.recordType, 80).toLocaleUpperCase()
      !== clean(target.recordType, 80).toLocaleUpperCase()) return false;
    const sameValue = (expected, actual) => !expected || normalized(expected) === normalized(actual);
    if (!sameValue(resolution.scope?.tenantId, record.tenantId)
      || !sameValue(resolution.scope?.agentId, record.agentId)
      || !sameValue(target.tenantId, record.tenantId)
      || !sameValue(target.agentId, record.agentId)
      || !sameValue(target.knowledgeBaseId, record.knowledgeBaseId)
      || (revision(target.publicationRevision) !== null
        && revision(target.publicationRevision) !== revision(record.publicationRevision))) return false;
    const reasons = new Set((record.reservationReasons ?? []).map((reason) => normalized(reason)));
    const selectedSameSource = normalized(record.sourceId)
      && selectedSourceIds.has(normalized(record.sourceId));
    if (!selectedSameSource) return false;
    const selectedSameEntity = [target.id, target.recordId, target.key, target.name]
      .map((value) => normalized(value)).filter(Boolean)
      .some((value) => selectedEntityIdentities.has(value));
    if (!selectedSameEntity) return false;
    if (mode === 'CONTEXTUAL') {
      return reasons.has('canonical_memory');
    }
    const requiredReason = mode === 'COMPARISON' ? 'explicit_comparison' : 'explicit_entity';
    return reasons.has(requiredReason) || reasons.has('explicit_current_entity')
      || (mode === 'EXPLICIT' && reasons.has('category_unique_child'));
  });
  return supported ? resolution
    : unresolvedResolution(resolution, `${mode.toLocaleLowerCase()}_entity_not_confirmed`);
}

function uniqueRecords(values = []) {
  const records = [];
  const seen = new Set();
  for (const value of values) {
    const id = normalized(value?.recordId ?? value?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    records.push(value);
  }
  return Object.freeze(records.slice(0, 5));
}

function selectableCategoryChildren(category, records, evidence) {
  if (!category || category.recordType !== 'CATALOG_CATEGORY') return Object.freeze([]);
  const source = (Array.isArray(evidence) ? evidence : []).find((entry) => (
    normalized(entry?.recordId) === normalized(category.recordId)
    && String(entry?.recordType ?? '').toLocaleUpperCase() === 'CATALOG_CATEGORY'
  ));
  const publishedChildIds = new Set((source?.authoritativeData?.children ?? [])
    .filter((child) => child?.selectionRules?.selectable === true)
    .map((child) => normalized(child?.recordId)).filter(Boolean));
  if (!publishedChildIds.size) return Object.freeze([]);
  return uniqueRecords(records.filter((record) => (
    record.recordType === 'CATALOG_ITEM'
    && publishedChildIds.has(normalized(record.recordId))
    && normalized(record.categoryKey) === normalized(category.categoryKey)
    && normalized(record.knowledgeBaseId) === normalized(category.knowledgeBaseId)
    && record.publicationRevision === category.publicationRevision
  )));
}

export function resolveCanonicalTopicMemory({
  scope, understanding = {}, evidence = [], memory = {},
} = {}) {
  const isolatedScope = scoped(scope);
  understanding = understanding && typeof understanding === 'object' ? understanding : {};
  memory = memory && typeof memory === 'object' ? memory : {};
  const records = uniqueRecords((Array.isArray(evidence) ? evidence : [])
    .map((source) => canonicalRecord(source, isolatedScope)).filter(Boolean));
  const byId = new Map(records.map((record) => [normalized(record.recordId), record]));
  const resolveIds = (values) => uniqueRecords((Array.isArray(values) ? values : [])
    .map((value) => byId.get(normalized(value?.recordId ?? value?.id))).filter(Boolean));
  const comparisonEntities = resolveIds(understanding.comparisonEntities);
  const requestedComparisonIds = [...new Set((understanding.comparisonEntities ?? [])
    .map((value) => normalized(value?.recordId ?? value?.id)).filter(Boolean))];
  if (requestedComparisonIds.length > 1
    && comparisonEntities.length !== requestedComparisonIds.length) {
    return Object.freeze({
      version: CANONICAL_TOPIC_MEMORY_VERSION,
      scope: isolatedScope,
      mode: 'UNRESOLVED',
      activeEntity: null,
      activeCategory: null,
      comparisonEntities: uniqueRecords(memory.comparisonEntities),
      requiresTargetedClarification: true,
      reason: 'comparison_records_not_fully_hydrated',
    });
  }
  const explicitEntities = resolveIds(understanding.explicitEntities);
  const explicitCategories = resolveIds(understanding.explicitCategories);
  if (comparisonEntities.length > 1) {
    return Object.freeze({
      version: CANONICAL_TOPIC_MEMORY_VERSION,
      scope: isolatedScope,
      mode: 'COMPARISON',
      activeEntity: null,
      activeCategory: null,
      comparisonEntities,
      requiresTargetedClarification: false,
    });
  }
  const explicitSelections = uniqueRecords([...explicitEntities, ...explicitCategories]);
  if (understanding.ambiguity?.detected === true || explicitSelections.length > 1) {
    return Object.freeze({
      version: CANONICAL_TOPIC_MEMORY_VERSION,
      scope: isolatedScope,
      mode: 'UNRESOLVED',
      activeEntity: null,
      activeCategory: null,
      comparisonEntities: uniqueRecords(memory.comparisonEntities),
      requiresTargetedClarification: true,
      reason: 'explicit_catalog_selection_ambiguous',
    });
  }
  let explicit = explicitSelections[0] ?? null;
  if (explicit?.recordType === 'CATALOG_CATEGORY') {
    const selectableChildren = selectableCategoryChildren(explicit, records, evidence);
    if (selectableChildren.length === 1) [explicit] = selectableChildren;
    else if (selectableChildren.length > 1) {
      return Object.freeze({
        version: CANONICAL_TOPIC_MEMORY_VERSION,
        scope: isolatedScope,
        mode: 'EXPLICIT',
        activeEntity: null,
        activeCategory: explicit,
        comparisonEntities: Object.freeze([]),
        categoryCandidates: selectableChildren,
        requiresTargetedClarification: true,
        reason: 'category_item_selection_required',
      });
    }
  }
  if (explicit) {
    return Object.freeze({
      version: CANONICAL_TOPIC_MEMORY_VERSION,
      scope: isolatedScope,
      mode: 'EXPLICIT',
      activeEntity: explicit.entityType === 'ITEM' ? explicit : null,
      activeCategory: explicit.entityType === 'CATEGORY' ? explicit : null,
      comparisonEntities: Object.freeze([]),
      requiresTargetedClarification: false,
    });
  }
  if (understanding.contextDependent === true) {
    const remembered = memory.activeEntity ?? memory.activeCategory;
    const canonical = byId.get(normalized(remembered?.recordId ?? remembered?.id)) ?? null;
    if (canonical) {
      return Object.freeze({
        version: CANONICAL_TOPIC_MEMORY_VERSION,
        scope: isolatedScope,
        mode: 'CONTEXTUAL',
        activeEntity: canonical.entityType === 'ITEM' ? canonical : null,
        activeCategory: canonical.entityType === 'CATEGORY' ? canonical : null,
        comparisonEntities: uniqueRecords(memory.comparisonEntities),
        requiresTargetedClarification: false,
      });
    }
  }
  return Object.freeze({
    version: CANONICAL_TOPIC_MEMORY_VERSION,
    scope: isolatedScope,
    mode: 'UNRESOLVED',
    activeEntity: null,
    activeCategory: null,
    comparisonEntities: uniqueRecords(memory.comparisonEntities),
    requiresTargetedClarification: (understanding.contextualReferences?.length ?? 0) > 0,
  });
}

