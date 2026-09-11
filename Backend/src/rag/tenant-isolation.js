import { env } from '../config/env.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
