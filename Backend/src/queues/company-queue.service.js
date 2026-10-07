import { withTenantContext } from '../infrastructure/database-context.js';
import { redis } from '../infrastructure/redis.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { inboundQueueKeys } from '../voice/inbound-call-queue.service.js';
import { isCompanyCallQueueEnabled, requireCompanyCallQueueEnabled } from './company-queue-feature.js';

const snapshotScript = `-- company-queue-snapshot
local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  redis.call('HDEL', KEYS[5], id)
  redis.call('HDEL', KEYS[8], id)
  redis.call('SET', ARGV[4] .. id .. ':ended', 'expired', 'EX', 3900)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local active = redis.call('ZRANGE', KEYS[1], ARGV[2], ARGV[3])
local activeMetadata = {}
for _, id in ipairs(active) do table.insert(activeMetadata, redis.call('GET', ARGV[4] .. id .. ':metadata') or '{}') end
local waiting = redis.call('ZRANGE', KEYS[3], ARGV[2], ARGV[3])
local waitingMetadata = {}
for _, id in ipairs(waiting) do table.insert(waitingMetadata, redis.call('HGET', KEYS[8], id) or '{}') end
return {redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[3]), active, activeMetadata, waiting, waitingMetadata}`;

function scoped(auth) {
  if (!auth.tenantId) throw new AppError(403, 'A company context is required', 'TENANT_CONTEXT_REQUIRED');
}

function details(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

export async function getCompanyQueue(auth, filters, dependencies = {}) {
  scoped(auth);
  const clientRedis = dependencies.redis ?? redis;
  if (clientRedis.status && clientRedis.status !== 'ready') throw new AppError(503, 'Queue telemetry is unavailable', 'VOICE_COORDINATION_UNAVAILABLE');
  const now = dependencies.now?.() ?? Date.now();
  const offset = (filters.page - 1) * filters.pageSize;
  const run = dependencies.contextRunner ?? (operation => withTenantContext(auth, operation));
  const prefix = `${env.QUEUE_PREFIX}:voice:tenant:{${auth.tenantId}}:call:`;
  const [databaseData, snapshot] = await Promise.all([
    run(async client => {
      const limits = await client.query(`SELECT max_total_concurrency,max_inbound_queue_size,
        max_inbound_wait_seconds,max_outbound_queued_tasks FROM tenant_limits WHERE tenant_id=$1`, [auth.tenantId]);
      if (!limits.rowCount) throw new AppError(404, 'Company queue settings were not found', 'COMPANY_QUEUE_CONFIGURATION_MISSING');
      const count = await client.query(`SELECT count(*)::int count FROM (
        SELECT id FROM campaign_tasks WHERE tenant_id=$1 AND status='queued' AND archived_at IS NULL
        UNION ALL SELECT id FROM agent_phone_test_requests WHERE tenant_id=$1 AND status='queued'
        UNION ALL SELECT id FROM scheduled_follow_up_tasks WHERE tenant_id=$1 AND status='scheduled' AND campaign_task_id IS NULL
      ) waiting`, [auth.tenantId]);
      const waiting = await client.query(`SELECT * FROM (SELECT t.id,t.lead_phone,t.source::text,t.queue_reason::text,t.scheduled_for,
        COALESCE((SELECT max(a.ended_at) FROM campaign_task_attempts a WHERE a.task_id=t.id),t.created_at) AS waiting_since,
        t.agent_id,va.name AS agent_name,t.campaign_id,c.name AS campaign_name,c.status::text AS campaign_status,
        t.last_error,t.created_at FROM campaign_tasks t
        JOIN campaigns c ON c.id=t.campaign_id AND c.tenant_id=t.tenant_id
        JOIN voice_agents va ON va.id=t.agent_id AND va.tenant_id=t.tenant_id
        WHERE t.tenant_id=$1 AND t.status='queued' AND t.archived_at IS NULL
        UNION ALL SELECT p.id,p.phone,CASE WHEN p.follow_up_task_id IS NOT NULL THEN 'follow_up' ELSE 'phone_test' END,p.queue_reason,NULL::timestamptz,p.created_at,
          p.agent_id,a.name,NULL::uuid,NULL::text,NULL::text,p.last_error,p.created_at
        FROM agent_phone_test_requests p JOIN voice_agents a ON a.id=p.agent_id AND a.tenant_id=p.tenant_id
        WHERE p.tenant_id=$1 AND p.status='queued'
        UNION ALL SELECT f.id,ct.phone_e164,'follow_up','scheduled',f.scheduled_for,f.created_at,
          f.agent_id,va.name,NULL::uuid,NULL::text,NULL::text,f.last_error_code,f.created_at
          FROM scheduled_follow_up_tasks f JOIN contact_conversations cv ON cv.id=f.conversation_id AND cv.tenant_id=f.tenant_id
          JOIN conversation_contacts ct ON ct.id=cv.contact_id AND ct.tenant_id=cv.tenant_id
          JOIN voice_agents va ON va.id=f.agent_id AND va.tenant_id=f.tenant_id
          WHERE f.tenant_id=$1 AND f.status='scheduled' AND f.campaign_task_id IS NULL) waiting
        ORDER BY created_at,id LIMIT $2 OFFSET $3`, [auth.tenantId, filters.pageSize, offset]);
      return { limits: limits.rows[0], outboundCount: Number(count.rows[0].count), outbound: waiting.rows };
    }),
    clientRedis.eval(snapshotScript, 8, ...inboundQueueKeys(auth.tenantId, 'snapshot'),
      now, offset, offset + filters.pageSize - 1, prefix).catch(() => {
      throw new AppError(503, 'Queue telemetry is unavailable', 'VOICE_COORDINATION_UNAVAILABLE');
    }),
  ]);
  const [activeCount, inboundCount, activeIds, activeMetadata, inboundIds, inboundMetadata] = snapshot;
  const activeRows = activeIds.length ? await run(async client => (await client.query(`SELECT c.id,c.provider_call_id,
    c.provider_metadata->>'capacityReservationId' AS reservation_id,c.direction,c.status,c.from_number,c.to_number,
    c.agent_id,c.agent_name,c.campaign_id,c.campaign_name,c.started_at FROM call_sessions c
    WHERE c.tenant_id=$1 AND c.ended_at IS NULL AND c.telephony_account_id IS NOT NULL
      AND (c.provider_call_id=ANY($2::text[]) OR c.provider_metadata->>'capacityReservationId'=ANY($2::text[]))`,
  [auth.tenantId, activeIds])).rows) : [];
  const limits = databaseData.limits;
  return {
    queueEnabled: isCompanyCallQueueEnabled(auth.tenantId),
    settings: { maxTotalConcurrency: limits.max_total_concurrency, maxInboundQueueSize: limits.max_inbound_queue_size,
      maxInboundWaitSeconds: limits.max_inbound_wait_seconds, maxOutboundQueuedTasks: limits.max_outbound_queued_tasks },
    totals: { active: Number(activeCount), inboundWaiting: Number(inboundCount), outboundWaiting: databaseData.outboundCount },
    active: activeIds.map((id, index) => {
      const metadata = details(activeMetadata[index]);
      const row = activeRows.find(call => call.provider_call_id === id || call.reservation_id === id);
      return { id, phone: row ? row.direction === 'inbound' ? row.from_number : row.to_number : metadata.phone ?? '',
        direction: row?.direction ?? metadata.direction ?? 'inbound', status: row?.status ?? 'preparing',
        agentId: row?.agent_id ?? metadata.agentId, agentName: row?.agent_name ?? metadata.agentName ?? 'Preparing call',
        campaignId: row?.campaign_id ?? metadata.campaignId, campaignName: row?.campaign_name ?? metadata.campaignName ?? null,
        durationSeconds: Math.max(0, Math.floor((now - (row ? new Date(row.started_at).getTime() : metadata.startedAt ?? now)) / 1000)) };
    }),
    inbound: inboundIds.map((id, index) => {
      const metadata = details(inboundMetadata[index]);
      return { id, ...metadata, reason: 'company_capacity',
        waitSeconds: Math.max(0, Math.floor((now - (metadata.arrivedAt ?? now)) / 1000)) };
    }),
    outbound: databaseData.outbound.map(row => ({ id: row.id, phone: row.lead_phone, source: row.source,
      agentId: row.agent_id, agentName: row.agent_name, campaignId: row.campaign_id, campaignName: row.campaign_name,
      campaignStatus: row.campaign_status, scheduledFor: row.scheduled_for,
      reason: row.campaign_status === 'paused' || row.campaign_status === 'draft' ? 'campaign_paused'
        : new Date(row.scheduled_for).getTime() > now ? 'scheduled' : row.queue_reason,
      waitSeconds: Math.max(0, Math.floor((now - new Date(row.waiting_since).getTime()) / 1000)) })),
    pagination: { ...filters, totalPages: Math.max(1, Math.ceil(Math.max(Number(activeCount), Number(inboundCount), databaseData.outboundCount) / filters.pageSize)) },
    permissions: { canManage: isCompanyCallQueueEnabled(auth.tenantId) && (auth.role === 'SUPER_ADMIN' || auth.role === 'COMPANY_DEVELOPER') },
    updatedAt: new Date(now).toISOString(),
  };
}

export async function cancelCompanyQueuedTask(auth, taskId, dependencies = {}) {
  scoped(auth);
  if (!['SUPER_ADMIN', 'COMPANY_DEVELOPER'].includes(auth.role)) throw new AppError(403, 'Only Developers can manage company waiting tasks', 'FORBIDDEN');
  requireCompanyCallQueueEnabled(auth.tenantId);
  const run = dependencies.contextRunner ?? (operation => withTenantContext(auth, operation));
  return run(async client => {
    const result = await client.query(`UPDATE campaign_tasks SET status='canceled',final_outcome='canceled',completed_at=now()
      WHERE id=$1 AND tenant_id=$2 AND status='queued' AND archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM campaign_task_attempts a WHERE a.task_id=campaign_tasks.id
          AND a.ended_at IS NULL AND a.started_at IS NOT NULL) RETURNING id,campaign_id`, [taskId, auth.tenantId]);
    if (!result.rowCount) throw new AppError(409, 'Waiting task was not found or has already started', 'QUEUE_TASK_NOT_CANCELABLE');
    const task = result.rows[0];
    await client.query('UPDATE campaigns SET completed_tasks=completed_tasks+1 WHERE id=$1 AND tenant_id=$2', [task.campaign_id, auth.tenantId]);
    await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_user_id,actor_type,action,entity_type,entity_id,after_data)
      VALUES($1,$2,$3,'user','QUEUED_TASK_CANCELED','campaign_task',$4,$5::jsonb)`,
    [auth.tenantId, auth.workspaceId, auth.userId, task.id, JSON.stringify({ status: 'canceled' })]);
    // Existing BullMQ jobs become no-ops through the worker's status check.
    return { id: task.id, status: 'canceled' };
  });
}
