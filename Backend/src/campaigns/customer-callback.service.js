import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { getQueue } from '../queues/queue.registry.js';
import { logger } from '../config/logger.js';

const maxCallbackDelayMs = 30 * 24 * 60 * 60 * 1000;
const minCallbackDelayMs = 30 * 1000;
const numberWords = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});
const callbackIntent = /(?:call\s+me(?:\s+back)?|call\s+back|callback|call\s+pannu(?:nga)?|koopidu|kooppidu|கால்|கூப்பிட|அழை)/iu;
const timeDirection = /(?:after|later|\bin\b|aprom|apram|கழித்து|பிறகு)/iu;
const durationPattern = /(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|வினாடி(?:கள்)?|நிமிட(?:ம்|ங்கள்)?|நிமிஷ(?:ம்|ங்கள்)?|மணி(?:நேரம்)?|நாட்கள்?|நாள்)/iu;

function cleanText(value) {
  return String(value ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function durationMilliseconds(amount, unit) {
  if (/^(?:sec|வினாடி)/iu.test(unit)) return amount * 1000;
  if (/^(?:hour|hr|மணி)/iu.test(unit)) return amount * 60 * 60 * 1000;
  if (/^(?:day|நாள்|நாட்)/iu.test(unit)) return amount * 24 * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

export function resolveCustomerCallbackRequest(value, options = {}) {
  const text = cleanText(value);
  if (!text || !callbackIntent.test(text)) return Object.freeze({ detected: false, resolved: false });
  if (!timeDirection.test(text)) {
    return Object.freeze({ detected: true, resolved: false, reason: 'time_not_understood', requestText: text });
  }
  const match = text.match(durationPattern);
  if (!match) return Object.freeze({ detected: true, resolved: false, reason: 'time_not_understood', requestText: text });
  const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : numberWords[match[1].toLowerCase()];
  const delayMs = durationMilliseconds(amount, match[2]);
  const minimumDelayMs = Math.max(minCallbackDelayMs, Number(options.minimumDelaySeconds ?? 30) * 1000);
  const maximumDelayMs = Math.min(maxCallbackDelayMs, Number(options.maximumDelayDays ?? 30) * 86400000);
  if (!Number.isFinite(delayMs) || delayMs < minimumDelayMs || delayMs > maximumDelayMs) {
    return Object.freeze({ detected: true, resolved: false, reason: 'time_out_of_range', requestText: text });
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  return Object.freeze({
    detected: true,
    resolved: true,
    source: 'relative_duration',
    delayMs,
    requestedFor: new Date(now.getTime() + delayMs).toISOString(),
    requestText: text,
  });
}

function runWithPlatformContext(dependencies, operation) {
  const runner = dependencies.contextRunner;
  return runner ? runner(operation) : withPlatformAdminContext(null, operation);
}

export async function scheduleCustomerCallback(input, dependencies = {}) {
  if (!input?.callId || !input?.tenantId) throw new TypeError('callId and tenantId are required');
  const requestedFor = new Date(input.requestedFor);
  const delay = requestedFor.getTime() - Date.now();
  const minimumDelayMs = Math.max(minCallbackDelayMs, Number(input.minimumDelaySeconds ?? 30) * 1000);
  const maximumDelayMs = Math.min(maxCallbackDelayMs, Number(input.maximumDelayDays ?? 30) * 86400000);
  // Allow a small processing-time tolerance because requestedFor is resolved
  // from the transcript immediately before this database/queue operation.
  if (!Number.isFinite(requestedFor.getTime()) || delay < minimumDelayMs - 2000 || delay > maximumDelayMs) {
    return { scheduled: false, reason: 'callback_time_out_of_range' };
  }

  const scheduled = await runWithPlatformContext(dependencies, async (client) => {
    const selected = await client.query(`SELECT t.id AS task_id,t.tenant_id,t.workspace_id,t.campaign_id,
        t.retry_count,t.max_retries,t.callback_origin_attempt_id,t.callback_scheduled_for,
        a.id AS attempt_id
      FROM call_sessions c
      JOIN campaign_task_attempts a ON a.call_session_id=c.id AND a.tenant_id=c.tenant_id
      JOIN campaign_tasks t ON t.id=a.task_id AND t.tenant_id=c.tenant_id
      WHERE c.id=$1 AND c.tenant_id=$2
      ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE OF t`, [input.callId, input.tenantId]);
    if (!selected.rowCount) return { scheduled: false, reason: 'not_campaign_call' };
    const task = selected.rows[0];
    if (task.callback_origin_attempt_id === task.attempt_id && task.callback_scheduled_for) {
      return {
        scheduled: true, idempotent: true, taskId: task.task_id,
        retryCount: Number(task.retry_count), requestedFor: new Date(task.callback_scheduled_for).toISOString(),
      };
    }
    if (Number(task.retry_count) >= Number(task.max_retries)) {
      return { scheduled: false, reason: 'retry_limit_reached', taskId: task.task_id };
    }
    const retryCount = Number(task.retry_count) + 1;
    await client.query(`UPDATE campaign_tasks SET status='queued',queue_reason='scheduled',retry_count=$3,
        scheduled_for=$4,final_outcome=NULL,last_error=NULL,completed_at=NULL,
        callback_requested_at=now(),callback_scheduled_for=$4,callback_origin_attempt_id=$5,
        callback_request_text=$6
      WHERE id=$1 AND tenant_id=$2`, [
      task.task_id, input.tenantId, retryCount, requestedFor, task.attempt_id, cleanText(input.requestText),
    ]);
    return {
      scheduled: true, idempotent: false, taskId: task.task_id, tenantId: task.tenant_id,
      workspaceId: task.workspace_id, campaignId: task.campaign_id, retryCount,
      requestedFor: requestedFor.toISOString(),
    };
  });
  if (!scheduled.scheduled || scheduled.idempotent) return scheduled;

  const queue = dependencies.queue ?? getQueue('call-retries');
  try {
    await queue.add('campaign-task', {
      taskId: scheduled.taskId,
      tenantId: scheduled.tenantId,
      workspaceId: scheduled.workspaceId,
      campaignId: scheduled.campaignId,
    }, {
      jobId: `${scheduled.taskId}:callback:${scheduled.retryCount}`,
      delay: Math.max(0, new Date(scheduled.requestedFor).getTime() - Date.now()),
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    logger.info({
      stage: 'callback.scheduled', callId: input.callId, taskId: scheduled.taskId,
      retryCount: scheduled.retryCount, requestedFor: scheduled.requestedFor,
    }, 'Customer-requested callback scheduled');
    return scheduled;
  } catch (error) {
    await runWithPlatformContext(dependencies, (client) => client.query(
      `UPDATE campaign_tasks SET queue_reason='queue_unavailable',last_error=$3
        WHERE id=$1 AND tenant_id=$2 AND callback_origin_attempt_id IS NOT NULL`,
      [scheduled.taskId, input.tenantId, 'Callback queue was unavailable'],
    )).catch(() => {});
    logger.error({
      errorCode: error?.code ?? 'CALLBACK_QUEUE_ADD_FAILED',
      stage: 'callback.queue_failed', callId: input.callId, taskId: scheduled.taskId,
    }, 'Customer-requested callback could not be queued');
    return { ...scheduled, scheduled: false, reason: 'queue_unavailable' };
  }
}
