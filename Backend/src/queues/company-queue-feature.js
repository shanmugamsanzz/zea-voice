import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';

export function isCompanyCallQueueEnabled(tenantId, configuration = env) {
  if (!configuration.VOICE_COMPANY_QUEUE_ENABLED) return false;
  const companies = configuration.VOICE_COMPANY_QUEUE_TENANT_IDS.split(',').map(id => id.trim()).filter(Boolean);
  return companies.length === 0 || companies.includes(tenantId);
}

export function requireCompanyCallQueueEnabled(tenantId) {
  if (!isCompanyCallQueueEnabled(tenantId)) {
    throw new AppError(409, 'Company call queue management is not enabled', 'COMPANY_CALL_QUEUE_DISABLED');
  }
}

export function shouldQueueInboundCall({ tenantId, direction, queuePoll }, configuration = env) {
  return direction === 'inbound' && (isCompanyCallQueueEnabled(tenantId, configuration) || queuePoll === true);
}
