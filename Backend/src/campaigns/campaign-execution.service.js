import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { makePlivoCall } from '../telephony/plivo.client.js';
import { getQueue } from '../queues/queue.registry.js';
import { logger } from '../config/logger.js';

const terminalOutcomes = new Set(['completed', 'failed', 'busy', 'no_answer', 'rejected', 'unavailable', 'canceled']);

function callbackUrl(attemptId, type) {
  return `${env.PUBLIC_BASE_URL}/webhooks/plivo/calls/${attemptId}/${type}`;
}

function accountCallbackUrl(baseUrl, attemptId) {
  const url = new URL(baseUrl);
  url.searchParams.set('attempt_id', attemptId);
  return url.toString();
}

async function deferTask(task, delay = env.CONCURRENCY_RETRY_DELAY_MS) {
  const queue = getQueue(task.source === 'realtime' ? 'realtime-calls' : 'batch-calls');
  await queue.add('campaign-task', {
    taskId: task.id, tenantId: task.tenant_id, workspaceId: task.workspace_id, campaignId: task.campaign_id,
  }, { jobId: `${task.id}:defer:${Date.now()}`, delay, removeOnComplete: 1000, removeOnFail: 5000 });
}

async function claimTask(taskId) {
  return withPlatformAdminContext(null, async (client) => {
    const selected = await client.query(`
      SELECT t.*, c.status AS campaign_status, c.name AS campaign_name,
        c.concurrency_limit, c.retry_intervals_ms, c.retry_outcomes,
        c.calling_start_time, c.calling_end_time, c.timezone, c.start_after, c.end_after,
        a.name AS agent_name, n.e164 AS from_number, n.telephony_account_id,
        p.auth_id, p.auth_token_encrypted, p.base_url, p.answer_url, p.hangup_url,
        p.recording_callback_url, l.max_total_concurrency,
        w.balance - w.reserved_balance AS available_credits
      FROM campaign_tasks t
      JOIN campaigns c ON c.id = t.campaign_id AND c.tenant_id = t.tenant_id
      JOIN voice_agents a ON a.id = t.agent_id
      JOIN phone_numbers n ON n.id = t.phone_number_id
      JOIN telephony_accounts p ON p.id = n.telephony_account_id
      JOIN tenant_limits l ON l.tenant_id = t.tenant_id
      JOIN company_credit_wallets w ON w.tenant_id = t.tenant_id
      WHERE t.id = $1 AND t.archived_at IS NULL
      FOR UPDATE OF t`, [taskId]);
    if (!selected.rowCount) return { action: 'ignored', reason: 'not_found' };
    const task = selected.rows[0];
    if (task.status !== 'queued') return { action: 'ignored', reason: `status_${task.status}` };

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [task.tenant_id, task.campaign_id]);
    if (['paused', 'draft'].includes(task.campaign_status)) {
      await client.query("UPDATE campaign_tasks SET queue_reason='campaign_paused' WHERE id=$1", [task.id]);
      return { action: 'deferred', task, reason: 'campaign_paused', enqueue: false };
    }
    if (['completed', 'failed', 'archived'].includes(task.campaign_status)) {
      return { action: 'ignored', reason: 'campaign_closed' };
    }
    if (Number(task.available_credits) <= 0) {
      await client.query("UPDATE campaign_tasks SET queue_reason='waiting_credits' WHERE id=$1", [task.id]);
      return { action: 'deferred', task, reason: 'waiting_credits', enqueue: false };
    }

    const allowed = await client.query(`SELECT CASE
      WHEN $1::time < $2::time THEN (now() AT TIME ZONE $3)::time >= $1::time AND (now() AT TIME ZONE $3)::time < $2::time
      ELSE (now() AT TIME ZONE $3)::time >= $1::time OR (now() AT TIME ZONE $3)::time < $2::time END AS allowed`,
    [task.calling_start_time, task.calling_end_time, task.timezone]);
    if (!allowed.rows[0].allowed || (task.start_after && new Date(task.start_after) > new Date())
      || (task.end_after && new Date(task.end_after) <= new Date())) {
      await client.query("UPDATE campaign_tasks SET queue_reason='calling_hours' WHERE id=$1", [task.id]);
      return { action: 'deferred', task, reason: 'calling_hours', enqueue: true };
    }

    const active = await client.query(`SELECT
      count(*) FILTER (WHERE tenant_id=$1)::int AS company_active,
      count(*) FILTER (WHERE campaign_id=$2)::int AS campaign_active
      FROM campaign_tasks WHERE status='running'`, [task.tenant_id, task.campaign_id]);
    if (active.rows[0].company_active >= task.max_total_concurrency
      || active.rows[0].campaign_active >= task.concurrency_limit) {
      return { action: 'deferred', task, reason: 'concurrency', enqueue: true };
    }

    const attemptNumber = task.retry_count + 1;
    const attempt = (await client.query(`INSERT INTO campaign_task_attempts
      (tenant_id, task_id, attempt_number, status, scheduled_for, started_at)
      VALUES ($1,$2,$3,'queued',$4,now())
      ON CONFLICT (task_id,attempt_number) DO UPDATE SET started_at=COALESCE(campaign_task_attempts.started_at,now())
      RETURNING *`, [task.tenant_id, task.id, attemptNumber, task.scheduled_for])).rows[0];
    const call = (await client.query(`INSERT INTO call_sessions
      (tenant_id,workspace_id,telephony_account_id,phone_number_id,agent_id,agent_name,
       campaign_id,campaign_name,from_number,to_number,direction,status,provider_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'outbound','queued',$11::jsonb) RETURNING id`,
    [task.tenant_id, task.workspace_id, task.telephony_account_id, task.phone_number_id,
      task.agent_id, task.agent_name, task.campaign_id, task.campaign_name, task.from_number,
      task.lead_phone, JSON.stringify({
        taskId: task.id, attemptId: attempt.id, leadName: task.lead_name, context: task.context,
      })])).rows[0];
    await client.query("UPDATE campaign_task_attempts SET call_session_id=$2 WHERE id=$1", [attempt.id, call.id]);
    await client.query("UPDATE campaign_tasks SET status='running',queue_reason='ready',last_error=NULL WHERE id=$1", [task.id]);
    if (attemptNumber === 1) await client.query('UPDATE campaigns SET attempted_tasks=attempted_tasks+1,status=\'running\' WHERE id=$1', [task.campaign_id]);
    return { action: 'call', task, attempt, callId: call.id };
  });
}

export async function executeCampaignTask(taskId, dependencies = {}) {
  const claimed = await claimTask(taskId);
  logger.info({
    stage: 'outbound.task_claimed', taskId, action: claimed.action,
    reason: claimed.reason ?? null, campaignId: claimed.task?.campaign_id ?? null,
  }, `Outbound task ${claimed.action}`);
  if (claimed.action === 'deferred' && claimed.enqueue) await deferTask(claimed.task);
  if (claimed.action !== 'call') return claimed;
  if (!env.PUBLIC_BASE_URL || !claimed.task.answer_url || !claimed.task.hangup_url) {
    await finishAttempt(claimed.attempt.id, 'failed', {
      error: 'PUBLIC_BASE_URL and telephony account Answer/Hangup URLs are required',
    });
    return { action: 'failed', reason: 'configuration' };
  }
  const makeCall = dependencies.makeCall ?? makePlivoCall;
  try {
    const answerUrl = claimed.task.answer_url;
    const hangupUrl = accountCallbackUrl(claimed.task.hangup_url, claimed.attempt.id);
    logger.info({
      stage: 'outbound.plivo_dispatch', taskId: claimed.task.id,
      attemptId: claimed.attempt.id, callId: claimed.callId,
      direction: 'outbound', answerUrl, hangupUrl,
    }, 'Sending outbound call to Plivo');
    const response = await makeCall(claimed.task.auth_id,
      decryptCredential(claimed.task.auth_token_encrypted), {
        from: claimed.task.from_number,
        to: claimed.task.lead_phone,
        answerUrl,
        ringUrl: callbackUrl(claimed.attempt.id, 'ring'),
        hangupUrl,
      }, fetch, claimed.task.base_url);
    await withPlatformAdminContext(null, async (client) => {
      await client.query("UPDATE campaign_task_attempts SET status='ringing',provider_metadata=$2::jsonb WHERE id=$1",
        [claimed.attempt.id, JSON.stringify(response)]);
      await client.query("UPDATE call_sessions SET provider_call_id=$2,status='ringing',ringing_at=now(),provider_metadata=provider_metadata||$3::jsonb WHERE id=$1",
        [claimed.callId, response.requestUuid, JSON.stringify(response)]);
    });
    logger.info({
      stage: 'outbound.plivo_accepted', taskId: claimed.task.id,
      attemptId: claimed.attempt.id, callId: claimed.callId,
      providerCallId: response.requestUuid,
    }, 'Plivo accepted outbound call');
    return { action: 'started', attemptId: claimed.attempt.id, callId: claimed.callId, providerCallId: response.requestUuid };
  } catch (error) {
    logger.error({
      err: error, stage: 'outbound.plivo_failed', taskId: claimed.task.id,
      attemptId: claimed.attempt.id, callId: claimed.callId,
    }, 'Outbound call failed before answer');
    await finishAttempt(claimed.attempt.id, 'failed', { error: error.message });
    return { action: 'failed', reason: 'provider', error: error.message };
  }
}

export async function markAttemptRinging(attemptId, providerCallId, payload = {}) {
  return withPlatformAdminContext(null, async (client) => {
    await client.query(`UPDATE campaign_task_attempts SET status='ringing',
      provider_metadata=provider_metadata||$2::jsonb WHERE id=$1`, [attemptId, JSON.stringify(payload)]);
    await client.query(`UPDATE call_sessions SET status='ringing',ringing_at=COALESCE(ringing_at,now()),
      provider_call_id=COALESCE(provider_call_id,$2),provider_metadata=provider_metadata||$3::jsonb
      WHERE id=(SELECT call_session_id FROM campaign_task_attempts WHERE id=$1)`,
    [attemptId, providerCallId, JSON.stringify(payload)]);
  });
}

export async function finishAttempt(attemptId, outcome, details = {}) {
  if (!terminalOutcomes.has(outcome)) outcome = 'failed';
  const result = await withPlatformAdminContext(null, async (client) => {
    const found = await client.query(`SELECT a.*,t.campaign_id,t.id AS task_id,t.retry_count,t.max_retries,
      t.source,c.retry_outcomes,c.retry_intervals_ms FROM campaign_task_attempts a
      JOIN campaign_tasks t ON t.id=a.task_id JOIN campaigns c ON c.id=t.campaign_id
      WHERE a.id=$1 FOR UPDATE OF a,t`, [attemptId]);
    if (!found.rowCount) return { action: 'ignored', reason: 'attempt_not_found' };
    const row = found.rows[0];
    if (row.ended_at) return { action: 'ignored', reason: 'already_final' };
    const duration = Math.max(0, Number(details.durationSeconds ?? 0));
    await client.query(`UPDATE campaign_task_attempts SET status=$2::campaign_attempt_status,outcome=$2::text,ended_at=now(),error_message=$3,
      provider_metadata=provider_metadata||$4::jsonb WHERE id=$1`,
    [attemptId, outcome, details.error ?? null, JSON.stringify(details.payload ?? {})]);
    const callOutcome = ['rejected', 'unavailable'].includes(outcome) ? 'failed' : outcome;
    await client.query(`UPDATE call_sessions SET status=$2,ended_at=now(),duration_seconds=$3,
      answered_at=CASE WHEN $3>0 THEN COALESCE(answered_at,started_at) ELSE answered_at END,
      provider_metadata=provider_metadata||$4::jsonb WHERE id=$1`,
    [row.call_session_id, callOutcome, duration, JSON.stringify(details.payload ?? {})]);
    const retryable = row.retry_outcomes.includes(outcome) && row.retry_count < row.max_retries;
    if (retryable) {
      const retryCount = row.retry_count + 1;
      const delay = Number(row.retry_intervals_ms[row.retry_count] ?? 0);
      await client.query(`UPDATE campaign_tasks SET status='queued',queue_reason='scheduled',retry_count=$2,
        scheduled_for=now()+($3::bigint*interval '1 millisecond'),final_outcome=NULL,last_error=$4 WHERE id=$1`,
      [row.task_id, retryCount, delay, details.error ?? null]);
      return { action: 'retry', taskId: row.task_id, source: row.source, retryCount, delay };
    }
    await client.query(`UPDATE campaign_tasks SET status=$2::campaign_task_status,final_outcome=$2::text,completed_at=now(),last_error=$3 WHERE id=$1`,
    [row.task_id, outcome, details.error ?? null]);
    await client.query(`UPDATE campaigns SET completed_tasks=completed_tasks+1,
      connected_tasks=connected_tasks+CASE WHEN $2>0 THEN 1 ELSE 0 END WHERE id=$1`,
    [row.campaign_id, duration]);
    return { action: 'final', taskId: row.task_id, outcome };
  });
  if (result.action === 'retry') {
    const queue = getQueue('call-retries');
    await queue.add('campaign-task', { taskId: result.taskId }, {
      jobId: `${result.taskId}:retry:${result.retryCount}`, delay: result.delay,
      removeOnComplete: 1000, removeOnFail: 5000,
    });
  }
  return result;
}

export async function wakeCreditWaitingTasks(tenantId) {
  const tasks = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`UPDATE campaign_tasks t SET queue_reason='ready'
      FROM campaigns c WHERE t.campaign_id=c.id AND t.tenant_id=$1 AND t.status='queued'
      AND t.queue_reason='waiting_credits' AND c.status='running' RETURNING t.*`, [tenantId]);
    return result.rows;
  });
  for (const task of tasks) {
    try { await deferTask(task, 0); } catch (error) {
      await withPlatformAdminContext(null, (client) => client.query(
        "UPDATE campaign_tasks SET queue_reason='queue_unavailable',last_error=$2 WHERE id=$1", [task.id, error.message],
      ));
    }
  }
  return tasks.length;
}

export async function wakePausedCampaignTasks(tenantId, campaignId) {
  const tasks = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`UPDATE campaign_tasks SET queue_reason='ready'
      WHERE tenant_id=$1 AND campaign_id=$2 AND status='queued' AND queue_reason='campaign_paused' RETURNING *`,
    [tenantId, campaignId]);
    return result.rows;
  });
  for (const task of tasks) await deferTask(task, 0);
  return tasks.length;
}
