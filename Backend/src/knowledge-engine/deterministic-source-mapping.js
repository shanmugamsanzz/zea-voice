import { canonicalRecordIdentityKey } from './canonical-record-identity.js';

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function scopedValue(source, key) {
  return source?.[key] ?? source?.provenance?.[key] ?? null;
}

export function deterministicSourceEntry(source = {}, sourceId = null) {
  const publishedEvidenceId = String(source.publishedEvidenceId
    ?? (/^source_\d+$/iu.test(String(source.id ?? '')) ? '' : source.id)
    ?? '').trim();
  const recordId = String(source.authoritativeRecordId ?? source.recordId ?? '').trim();
  const recordType = upper(source.recordType);
  const tenantId = String(scopedValue(source, 'tenantId') ?? '').trim();
  const agentId = String(scopedValue(source, 'agentId') ?? '').trim();
  const knowledgeBaseId = String(scopedValue(source, 'knowledgeBaseId') ?? '').trim();
  const publicationRevision = Number(scopedValue(source, 'publicationRevision'));
  const mapping = {
    sourceId: String(sourceId ?? source.sourceId
      ?? (/^source_\d+$/iu.test(String(source.id ?? '')) ? source.id : '')).trim(),
    publishedEvidenceId,
    authoritativeRecordId: recordId,
    recordId,
    recordType,
    tenantId,
    agentId,
    knowledgeBaseId,
    publicationRevision,
    documentId: String(scopedValue(source, 'documentId') ?? '').trim() || null,
    documentVersionId: String(scopedValue(source, 'documentVersionId') ?? '').trim() || null,
  };
  return Object.freeze({
    ...mapping,
    canonicalRecordIdentityKey: canonicalRecordIdentityKey(mapping),
  });
}

export function buildDeterministicSourceMap(sources = []) {
  const mappings = [];
  const sourceIds = new Set();
  const publishedIds = new Set();
  for (const [index, source] of sources.entries()) {
    const mapping = deterministicSourceEntry(source, source.sourceId ?? `source_${index + 1}`);
    if (!mapping.sourceId || !mapping.publishedEvidenceId || !mapping.authoritativeRecordId
      || !mapping.recordType || !mapping.tenantId || !mapping.agentId || !mapping.knowledgeBaseId
      || !Number.isInteger(mapping.publicationRevision)
      || mapping.publicationRevision < 1 || !mapping.canonicalRecordIdentityKey
      || (source.canonicalIdentityKey
        && source.canonicalIdentityKey !== mapping.canonicalRecordIdentityKey)) {
      throw new TypeError('Deterministic source mapping requires complete publication identity');
    }
    if (sourceIds.has(normalized(mapping.sourceId))
      || publishedIds.has(normalized(mapping.publishedEvidenceId))) {
      throw new TypeError('Deterministic source mapping requires unique source and evidence IDs');
    }
    sourceIds.add(normalized(mapping.sourceId));
    publishedIds.add(normalized(mapping.publishedEvidenceId));
    mappings.push(mapping);
  }
  return Object.freeze(mappings);
}

export function resolveDeterministicSource(mapping, authoritativeRecords = [], scope = {}) {
  if (!mapping?.sourceId || !mapping?.publishedEvidenceId) {
    return Object.freeze({ valid: false, reason: 'missing_evidence', record: null });
  }
  const publishedMatches = authoritativeRecords.filter((candidate) => (
    normalized(candidate?.publishedEvidenceId ?? candidate?.id)
      === normalized(mapping.publishedEvidenceId)
  ));
  if (!publishedMatches.length) {
    return Object.freeze({ valid: false, reason: 'missing_evidence', record: null });
  }
  const expectedTenant = normalized(scope.tenantId ?? mapping.tenantId);
  const expectedAgent = normalized(scope.agentId ?? mapping.agentId);
  const scopedMatches = publishedMatches.filter((candidate) => (
    (!expectedTenant || normalized(scopedValue(candidate, 'tenantId')) === expectedTenant)
    && (!expectedAgent || normalized(scopedValue(candidate, 'agentId')) === expectedAgent)
    && (!mapping.tenantId
      || normalized(scopedValue(candidate, 'tenantId')) === normalized(mapping.tenantId))
    && (!mapping.agentId
      || normalized(scopedValue(candidate, 'agentId')) === normalized(mapping.agentId))
  ));
  if (!scopedMatches.length) {
    return Object.freeze({ valid: false, reason: 'cross_tenant_evidence', record: null });
  }
  const record = scopedMatches.find((candidate) => (
    normalized(scopedValue(candidate, 'knowledgeBaseId')) === normalized(mapping.knowledgeBaseId)
    && normalized(candidate.recordId) === normalized(mapping.authoritativeRecordId)
    && upper(candidate.recordType) === upper(mapping.recordType)
  )) ?? scopedMatches[0];
  const authoritative = deterministicSourceEntry(record, mapping.sourceId);
  const activeRevisions = new Map((scope.publicationRevisions ?? []).map((entry) => [
    normalized(entry.knowledgeBaseId), Number(entry.publicationRevision ?? entry.revision),
  ]));
  const expectedRevision = activeRevisions.get(normalized(authoritative.knowledgeBaseId));
  if ((mapping.publicationRevision
      && Number(mapping.publicationRevision) !== authoritative.publicationRevision)
    || (expectedRevision !== undefined && expectedRevision !== authoritative.publicationRevision)) {
    return Object.freeze({ valid: false, reason: 'wrong_revision_evidence', record: null });
  }
  if (normalized(mapping.knowledgeBaseId) !== normalized(authoritative.knowledgeBaseId)
    || normalized(mapping.authoritativeRecordId) !== normalized(authoritative.authoritativeRecordId)
    || upper(mapping.recordType) !== upper(authoritative.recordType)
    || mapping.canonicalRecordIdentityKey !== authoritative.canonicalRecordIdentityKey) {
    return Object.freeze({ valid: false, reason: 'missing_evidence', record: null });
  }
  const stale = record.hydrationValidated !== true || record.publicationValidated === false
    || (record.documentStatus && record.documentStatus !== 'ready')
    || (record.documentVersionStatus && record.documentVersionStatus !== 'ready')
    || record.documentVersionIsCurrent === false;
  if (stale) return Object.freeze({ valid: false, reason: 'stale_evidence', record: null });
  if (!authoritative.documentId || !authoritative.documentVersionId) {
    return Object.freeze({ valid: false, reason: 'missing_evidence', record: null });
  }
  return Object.freeze({ valid: true, reason: null, record });
}
