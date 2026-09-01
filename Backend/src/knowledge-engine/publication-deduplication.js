import crypto from 'node:crypto';

export const PUBLICATION_DEDUPLICATION_VERSION = 1;

function clean(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function semanticProjection(record, recordType) {
  const metadata = plainObject(record?.entity_metadata ?? record?.metadata);
  const data = plainObject(record?.authoritativeData ?? record?.authoritative_data);
  const conditions = plainObject(first(metadata.conditions, data.conditions));
  const actionConfig = plainObject(first(metadata.actionConfig, metadata.action_config,
    data.actionConfig, data.action_config));
  const configured = clean(first(
    metadata.semanticIdentity, metadata.semantic_identity,
    data.semanticIdentity, data.semantic_identity,
  ));
  if (configured) return { recordType, configured };

  if (recordType === 'CATALOG_ITEM' || recordType === 'CATALOG_CATEGORY') return {
    recordType,
    itemKey: clean(first(metadata.itemKey, metadata.item_key, data.itemKey, data.item_key)),
    categoryKey: clean(first(
      metadata.categoryKey, metadata.category_key, data.categoryKey, data.category_key,
    )),
    name: clean(first(
      record?.entity_name, record?.entity_category, data.name, data.category,
      record?.canonicalName,
    )),
    facts: stableValue({
      description: first(data.description, record?.description),
      price: first(data.price, record?.price),
      currency: first(data.currency, record?.currency),
    }),
  };
  if (recordType === 'FAQ') return {
    recordType,
    question: clean(first(record?.question, data.question)),
    answer: clean(first(record?.answer, data.answer, record?.content)),
  };
  if (recordType === 'WORKFLOW_RULE') return {
    recordType,
    intent: clean(first(record?.intent, conditions.intentClass, metadata.intentClass, data.intent)),
    name: clean(first(record?.entity_name, record?.name, data.name)),
    conditions: stableValue(conditions),
    actionType: clean(first(metadata.actionType, metadata.action_type,
      data.actionType, data.action_type, record?.actionType)),
    actionConfig: stableValue(actionConfig),
    response: clean(first(record?.answer, record?.response_template,
      data.responseTemplate, record?.content)),
  };
  if (recordType === 'CONVERSATION_NODE') return {
    recordType,
    flowKey: clean(first(metadata.flowKey, metadata.flow_key, data.flowKey, data.flow_key)),
    nodeKey: clean(first(metadata.nodeKey, metadata.node_key, data.nodeKey, data.node_key)),
    language: clean(first(record?.language, data.language)),
    content: clean(first(record?.content, data.content)),
  };
  return {
    recordType,
    heading: clean(first(
      record?.source_heading, record?.source_section, data.heading, data.sourceSection,
    )),
    content: clean(first(record?.content, data.content)),
  };
}

export function buildPublicationDeduplicationIdentity(record = {}, scope = {}) {
  const recordType = String(first(
    record.record_type, record.recordType, record.type,
  ) ?? '').trim().toUpperCase();
  const tenantId = clean(first(scope.tenantId, record.tenant_id, record.tenantId), 160);
  const knowledgeBaseId = clean(first(
    scope.knowledgeBaseId, record.knowledge_base_id, record.knowledgeBaseId,
  ), 160);
  const publicationRevision = Number(first(
    scope.publicationRevision, record.publication_revision, record.publicationRevision,
  ));
  const documentId = clean(first(record.document_id, record.documentId), 160);
  const metadata = plainObject(record.entity_metadata ?? record.metadata);
  const data = plainObject(record.authoritativeData ?? record.authoritative_data);
  const dataMetadata = plainObject(data.metadata);
  const sourceSection = clean(first(
    record.source_section, record.sourceSection, record.source_heading,
    data.heading, data.nodeKey, data.itemKey, data.name,
  ), 500);
  const sourceLineStart = Number(first(
    record.source_line_start, record.sourceLineStart,
    metadata.sourceLineStart, metadata.source_line_start,
    dataMetadata.sourceLineStart, dataMetadata.source_line_start,
  ));
  const sourceLineEnd = Number(first(
    record.source_line_end, record.sourceLineEnd,
    metadata.sourceLineEnd, metadata.source_line_end,
    dataMetadata.sourceLineEnd, dataMetadata.source_line_end,
  ));
  const scoped = tenantId && knowledgeBaseId
    && Number.isInteger(publicationRevision) && publicationRevision > 0;
  const provenanceKey = scoped && documentId
    && (sourceSection || Number.isFinite(sourceLineStart) || Number.isFinite(sourceLineEnd))
    ? digest({
      tenantId, knowledgeBaseId, publicationRevision, documentId, recordType,
      sourceSection,
      sourceLineStart: Number.isFinite(sourceLineStart) ? sourceLineStart : null,
      sourceLineEnd: Number.isFinite(sourceLineEnd) ? sourceLineEnd : null,
    }) : null;
  const projection = semanticProjection(record, recordType);
  const meaningful = (value) => {
    if (Array.isArray(value)) return value.some(meaningful);
    if (value && typeof value === 'object') return Object.values(value).some(meaningful);
    return value !== '' && value !== null && value !== undefined;
  };
  const hasSemanticValue = Object.entries(projection)
    .some(([key, value]) => key !== 'recordType' && meaningful(value));
  const semanticKey = scoped && recordType && hasSemanticValue
    ? digest({ tenantId, knowledgeBaseId, publicationRevision, projection })
    : null;
  return Object.freeze({
    version: PUBLICATION_DEDUPLICATION_VERSION,
    provenanceKey,
    semanticKey,
  });
}

export function publicationDuplicateKeys(candidate = {}) {
  const identity = candidate.deduplicationIdentity ?? {};
  return Object.freeze([
    identity.provenanceKey ? `provenance:${identity.provenanceKey}` : null,
    identity.semanticKey ? `semantic:${identity.semanticKey}` : null,
  ].filter(Boolean));
}
