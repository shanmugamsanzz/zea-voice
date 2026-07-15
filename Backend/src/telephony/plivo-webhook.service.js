import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { finishAttempt, markAttemptRinging } from '../campaigns/campaign-execution.service.js';

function signedMessage(url, nonce, params) {
  const values = Object.entries(params ?? {}).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${Array.isArray(value) ? value.join('') : value ?? ''}`).join('');
  return `${url}${values}${nonce}`;
}

export function validatePlivoSignature(url, nonce, signatureHeader, authToken, params) {
  if (!nonce || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', authToken)
    .update(signedMessage(url, nonce, params)).digest('base64');
  return signatureHeader.split(',').some((candidate) => {
    const value = candidate.trim();
    return value.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}

async function attemptAccount(attemptId) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`SELECT p.auth_token_encrypted FROM campaign_task_attempts a
      JOIN campaign_tasks t ON t.id=a.task_id JOIN phone_numbers n ON n.id=t.phone_number_id
      JOIN telephony_accounts p ON p.id=n.telephony_account_id WHERE a.id=$1`, [attemptId]);
    if (!result.rowCount) throw new AppError(404, 'Call attempt was not found', 'CALL_ATTEMPT_NOT_FOUND');
    return result.rows[0];
  });
}

function outcome(payload) {
  const value = String(payload.HangupCauseName ?? payload.CallStatus ?? payload.Event ?? '')
    .toLowerCase().replace(/[ -]+/g, '_');
  if (value.includes('busy')) return 'busy';
  if (value.includes('no_answer') || value.includes('noanswer')) return 'no_answer';
  if (value.includes('reject') || value.includes('decline')) return 'rejected';
  if (value.includes('unavailable') || value.includes('unreachable')) return 'unavailable';
  if (value.includes('cancel')) return 'canceled';
  if (value.includes('complete') || value.includes('normal_clearing')) return 'completed';
  return 'failed';
}

async function recordOnce(attemptId, eventType, providerCallId, payload) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`INSERT INTO plivo_callback_events
      (attempt_id,provider_call_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(attempt_id,event_type,provider_call_id) DO NOTHING RETURNING id`,
    [attemptId, providerCallId, eventType, JSON.stringify(payload)]);
    return Boolean(result.rowCount);
  });
}

export async function processPlivoCallback(input) {
  if (!env.PUBLIC_BASE_URL) throw new AppError(503, 'PUBLIC_BASE_URL is not configured', 'PUBLIC_URL_NOT_CONFIGURED');
  const account = await attemptAccount(input.attemptId);
  const url = `${env.PUBLIC_BASE_URL}/webhooks/plivo/calls/${input.attemptId}/${input.eventType}`;
  if (!validatePlivoSignature(url, input.nonce, input.signature,
    decryptCredential(account.auth_token_encrypted), input.payload)) {
    throw new AppError(401, 'Invalid Plivo webhook signature', 'PLIVO_SIGNATURE_INVALID');
  }
  const providerCallId = String(input.payload.CallUUID ?? input.payload.RequestUUID ?? '').trim();
  if (!providerCallId) throw new AppError(400, 'Plivo callback has no call identifier', 'PLIVO_CALL_ID_MISSING');
  if (!await recordOnce(input.attemptId, input.eventType, providerCallId, input.payload)) {
    return { duplicate: true };
  }
  try {
    if (input.eventType === 'ring') {
      await markAttemptRinging(input.attemptId, providerCallId, input.payload);
      return { duplicate: false, status: 'ringing' };
    }
    const finalOutcome = outcome(input.payload);
    const result = await finishAttempt(input.attemptId, finalOutcome, {
      durationSeconds: Number(input.payload.BillDuration ?? input.payload.Duration ?? 0),
      payload: input.payload,
    });
    return { duplicate: false, status: finalOutcome, result };
  } catch (error) {
    await withPlatformAdminContext(null, (client) => client.query(
      'DELETE FROM plivo_callback_events WHERE attempt_id=$1 AND event_type=$2 AND provider_call_id=$3',
      [input.attemptId, input.eventType, providerCallId],
    ));
    throw error;
  }
}
