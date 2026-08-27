const namespaceByRecordType = Object.freeze({
  CATALOG_ITEM: 'CATALOG',
  CATALOG_CATEGORY: 'CATALOG',
  FAQ: 'FAQ',
  CONVERSATION_NODE: 'CONVERSATION',
  WORKFLOW_RULE: 'WORKFLOW',
  KNOWLEDGE_CHUNK: 'GENERAL',
});

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function normalizedType(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function canonicalRecordNamespace(recordType, namespace = null) {
  const type = normalizedType(recordType);
  return normalizedType(namespace) || namespaceByRecordType[type] || 'UNKNOWN';
}

export function canonicalRecordIdentity(value = {}, scope = {}) {
  value = value && typeof value === 'object' ? value : {};
  scope = scope && typeof scope === 'object' ? scope : {};
  const recordType = normalizedType(value.recordType ?? value.record_type ?? value.type);
  return Object.freeze({
    tenantId: normalized(value.tenantId ?? value.tenant_id ?? scope.tenantId ?? scope.tenant_id),
    knowledgeBaseId: normalized(value.knowledgeBaseId ?? value.knowledge_base_id
      ?? scope.knowledgeBaseId ?? scope.knowledge_base_id),
    publicationRevision: Number(value.publicationRevision ?? value.publication_revision
      ?? scope.publicationRevision ?? scope.publication_revision ?? 0),
    namespace: canonicalRecordNamespace(recordType, value.namespace ?? scope.namespace),
    recordType,
    recordId: normalized(value.recordId ?? value.record_id ?? value.id),
  });
}

export function typedRecordIdentityKey(value = {}) {
  const identity = canonicalRecordIdentity(value);
  if (!identity.recordType || !identity.recordId) return null;
  return `${identity.namespace}:${identity.recordType}:${identity.recordId}`;
}

export function canonicalRecordIdentityKey(value = {}, scope = {}) {
  const identity = canonicalRecordIdentity(value, scope);
  if (!identity.tenantId || !identity.knowledgeBaseId || !identity.publicationRevision
    || !identity.recordType || !identity.recordId) return null;
  return [
    identity.tenantId,
    identity.knowledgeBaseId,
    identity.publicationRevision,
    identity.namespace,
    identity.recordType,
    identity.recordId,
  ].join(':');
}
