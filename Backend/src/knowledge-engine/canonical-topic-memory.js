export const CANONICAL_TOPIC_MEMORY_VERSION = 1;

const catalogTypes = new Set(['CATALOG_ITEM', 'CATALOG_CATEGORY']);

function clean(value, maximum = 240) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalized(value) {
  return clean(value, 200).toLocaleLowerCase();
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
  return Object.freeze({
    id: recordId,
    recordId,
    recordType: category ? 'CATALOG_CATEGORY' : 'CATALOG_ITEM',
    entityType: category ? 'CATEGORY' : 'ITEM',
    key,
    name,
    category: clean(data.category, 240) || null,
    categoryKey: clean(data.categoryKey, 160) || null,
  });
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
  const explicit = explicitEntities[0] ?? explicitCategories[0] ?? null;
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

