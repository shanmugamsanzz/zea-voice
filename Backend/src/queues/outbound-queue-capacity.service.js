import { AppError } from '../middleware/errors.js';
import { isCompanyCallQueueEnabled } from './company-queue-feature.js';

export async function assertOutboundQueueSpace(client, tenantId, count) {
  if (count === 0) return;
  if (!isCompanyCallQueueEnabled(tenantId)) return;
  // Lock the company limit row so simultaneous imports and realtime producers
  // cannot both consume the same remaining queue space.
  const limits = await client.query('SELECT max_outbound_queued_tasks FROM tenant_limits WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
  if (!limits.rowCount) throw new AppError(409, 'Company queue limits are unavailable', 'COMPANY_QUEUE_CONFIGURATION_MISSING');
  const queued = await client.query("SELECT count(*)::int count FROM campaign_tasks WHERE tenant_id=$1 AND status='queued' AND archived_at IS NULL", [tenantId]);
  const maximum = Number(limits.rows[0].max_outbound_queued_tasks);
  const available = Math.max(0, maximum - Number(queued.rows[0].count));
  if (count > available) throw new AppError(429, 'Company outbound waiting queue is full', 'COMPANY_OUTBOUND_QUEUE_FULL', { limit: maximum, available });
}
