import { AppError } from '../middleware/errors.js';

export async function campaignDeletionPreview(client, auth, id) {
  const campaign = await client.query(`SELECT id,name,status FROM campaigns
    WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, [auth.tenantId, id]);
  if (!campaign.rowCount) throw new AppError(404, 'Campaign was not found', 'CAMPAIGN_NOT_FOUND');
  const counts = await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status IN ('queued','paused'))::int AS remaining
    FROM campaign_tasks WHERE tenant_id=$1 AND campaign_id=$2`, [auth.tenantId, id]);
  return { ...campaign.rows[0], totalTasks: counts.rows[0].total,
    remainingTasks: counts.rows[0].remaining };
}

// Caller owns the tenant-scoped transaction. Lock tasks before the campaign,
// matching dispatch's task-before-campaign update order.
export async function permanentlyDeleteCampaign(client, auth, id, confirmation) {
  if (confirmation?.confirmation !== 'DELETE'
    || !Number.isInteger(confirmation.expectedTaskCount) || confirmation.expectedTaskCount < 0) {
    throw new AppError(400, 'Type DELETE and review the task count before permanently deleting',
      'CAMPAIGN_DELETE_CONFIRMATION_REQUIRED');
  }
  await client.query(`SELECT id FROM campaign_tasks WHERE tenant_id=$1 AND campaign_id=$2
    ORDER BY id FOR UPDATE`, [auth.tenantId, id]);
  const result = await client.query(`SELECT id,name,status,workspace_id FROM campaigns
    WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, [auth.tenantId, id]);
  if (!result.rowCount) throw new AppError(404, 'Campaign was not found', 'CAMPAIGN_NOT_FOUND');
  const campaign = result.rows[0];
  const counts = await client.query(`SELECT count(*)::int AS total FROM campaign_tasks
    WHERE tenant_id=$1 AND campaign_id=$2`, [auth.tenantId, id]);
  if (counts.rows[0].total !== confirmation.expectedTaskCount) throw new AppError(409,
    'Campaign task count changed. Review the deletion warning again.', 'CAMPAIGN_DELETE_COUNT_CHANGED');
  if (campaign.status === 'running') throw new AppError(409,
    'Pause the campaign before deleting it', 'CAMPAIGN_MUST_BE_PAUSED');
  const active = await client.query(`SELECT 1 FROM call_sessions
    WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('queued','ringing','connected')
    UNION ALL SELECT 1 FROM campaign_tasks WHERE tenant_id=$1 AND campaign_id=$2 AND status='running'
    UNION ALL SELECT 1 FROM scheduled_follow_up_tasks f JOIN campaign_tasks t ON t.id=f.campaign_task_id
      AND t.tenant_id=f.tenant_id WHERE t.tenant_id=$1 AND t.campaign_id=$2
      AND f.status IN ('dispatching','initiated') LIMIT 1`, [auth.tenantId, id]);
  if (active.rowCount) throw new AppError(409, 'Wait for active campaign calls to finish before deleting',
    'CAMPAIGN_HAS_ACTIVE_CALLS');
  // Preserve conversation follow-up history while preventing future dispatch.
  // Both FK columns must be detached before task/attempt cascade deletion.
  await client.query(`UPDATE scheduled_follow_up_tasks f SET
    status=CASE WHEN f.status IN ('scheduled','queued') THEN 'canceled' ELSE f.status END,
    canceled_at=CASE WHEN f.status IN ('scheduled','queued') THEN now() ELSE f.canceled_at END,
    finished_at=CASE WHEN f.status IN ('scheduled','queued') THEN now() ELSE f.finished_at END,
    campaign_task_id=NULL,campaign_origin_attempt_id=NULL
    WHERE f.tenant_id=$1 AND (
      f.campaign_task_id IN (SELECT id FROM campaign_tasks WHERE tenant_id=$1 AND campaign_id=$2)
      OR f.campaign_origin_attempt_id IN (SELECT a.id FROM campaign_task_attempts a
        JOIN campaign_tasks t ON t.id=a.task_id AND t.tenant_id=a.tenant_id
        WHERE t.tenant_id=$1 AND t.campaign_id=$2))`, [auth.tenantId, id]);
  await client.query(`INSERT INTO audit_logs(tenant_id,workspace_id,actor_user_id,actor_type,
    action,entity_type,entity_id,after_data)
    VALUES($1,$2,$3,'user','CAMPAIGN_DELETED','campaign',$4,$5::jsonb)`,
  [auth.tenantId, campaign.workspace_id, auth.userId, id,
    JSON.stringify({ name: campaign.name, permanent: true })]);
  await client.query('DELETE FROM campaigns WHERE tenant_id=$1 AND id=$2', [auth.tenantId, id]);
  return { id, deleted: true };
}
