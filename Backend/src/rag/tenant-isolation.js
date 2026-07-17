import { env } from '../config/env.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedAgentUsage = new Set(['INBOUND', 'OUTBOUND', 'BOTH']);

export function requireTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !uuidPattern.test(tenantId)) {
    throw new TypeError('A valid tenant UUID is required');
  }
  return tenantId.toLowerCase();
}

export function requireEntityId(value, fieldName) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new TypeError(`A valid ${fieldName} UUID is required`);
  }
  return value.toLowerCase();
}

export function tenantCollectionName(tenantId) {
  const normalizedTenantId = requireTenantId(tenantId);
  return `${env.QDRANT_COLLECTION_PREFIX}_${normalizedTenantId.replaceAll('-', '_')}`;
}

export function tenantVectorPayload({
  tenantId,
  knowledgeBaseId,
  documentId,
  documentVersionId,
  agentUsage,
  category,
  pageNumber,
  recordId,
  recordType,
  publicationRevision,
  content,
}) {
  if (!allowedAgentUsage.has(agentUsage)) {
    throw new TypeError('agentUsage must be INBOUND, OUTBOUND, or BOTH');
  }
  if (typeof category !== 'string' || !category.trim()) {
    throw new TypeError('A vector category is required');
  }
  if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) {
    throw new TypeError('pageNumber must be a positive integer');
  }
  if (!Number.isInteger(publicationRevision) || publicationRevision < 1) {
    throw new TypeError('publicationRevision must be a positive integer');
  }
  if (typeof recordType !== 'string' || !recordType.trim()) {
    throw new TypeError('A vector recordType is required');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new TypeError('Vector content is required');
  }

  return Object.freeze({
    tenant_id: requireTenantId(tenantId),
    knowledge_base_id: requireEntityId(knowledgeBaseId, 'knowledgeBaseId'),
    document_id: requireEntityId(documentId, 'documentId'),
    document_version_id: requireEntityId(documentVersionId, 'documentVersionId'),
    record_id: requireEntityId(recordId, 'recordId'),
    record_type: recordType.trim().toUpperCase(),
    agent_usage: agentUsage,
    category: category.trim().toUpperCase(),
    publication_revision: publicationRevision,
    content: content.trim(),
    ...(pageNumber === undefined ? {} : { page_number: pageNumber }),
  });
}
