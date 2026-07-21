import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { finishAttempt, markAttemptRinging } from '../campaigns/campaign-execution.service.js';

function signedMessage(url, nonce, params) {
  const values = Object.entries(params ?? {}).sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  })
    .map(([key, value]) => `${key}${Array.isArray(value) ? value.join('') : value ?? ''}`).join('');
  return `${url}${values}${nonce}`;
}

export function validatePlivoSignature(url, nonce, signatureHeader, authToken, params) {
  if (!url || !nonce || !signatureHeader || !authToken) return false;
  const expected = crypto.createHmac('sha256', authToken)
    .update(signedMessage(url, nonce, params)).digest('base64');
  return signatureHeader.split(',').some((candidate) => {
    const value = candidate.trim();
    return value.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}

export function validatePlivoAccountSignatures(input) {
  const associatedValid = validatePlivoSignature(
    input.url, input.nonce, input.signature, input.authToken, input.params,
  );
  if (associatedValid) return true;
  return validatePlivoSignature(
    input.url, input.nonce, input.mainSignature, input.mainAuthToken, input.params,
  );
}

async function attemptAccount(attemptId) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`SELECT p.auth_token_encrypted, p.hangup_url,
        COALESCE(parent.auth_token_encrypted,p.auth_token_encrypted) AS main_auth_token_encrypted
      FROM campaign_task_attempts a
      JOIN campaign_tasks t ON t.id=a.task_id JOIN phone_numbers n ON n.id=t.phone_number_id
      JOIN telephony_accounts p ON p.id=n.telephony_account_id
      LEFT JOIN telephony_accounts parent ON parent.id=p.parent_account_id AND parent.deleted_at IS NULL
      WHERE a.id=$1`, [attemptId]);
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
  if (!input.useStoredUrl && !env.PUBLIC_BASE_URL) {
    throw new AppError(503, 'PUBLIC_BASE_URL is not configured', 'PUBLIC_URL_NOT_CONFIGURED');
  }
  const account = await attemptAccount(input.attemptId);
  let url = `${env.PUBLIC_BASE_URL}/webhooks/plivo/calls/${input.attemptId}/${input.eventType}`;
  if (input.useStoredUrl) {
    if (!account.hangup_url) {
      throw new AppError(503, 'Telephony account Hangup URL is not configured', 'PLIVO_HANGUP_URL_NOT_CONFIGURED');
    }
    const storedUrl = new URL(account.hangup_url);
    storedUrl.searchParams.set('attempt_id', input.attemptId);
    url = storedUrl.toString();
  }
  if (!validatePlivoAccountSignatures({
    url,
    nonce: input.nonce,
    signature: input.signature,
    mainSignature: input.mainSignature,
    authToken: decryptCredential(account.auth_token_encrypted),
    mainAuthToken: decryptCredential(account.main_auth_token_encrypted),
    params: input.payload,
  })) {
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

export async function processInboundPlivoHangup(input) {
  const providerCallId = String(input.payload?.CallUUID ?? input.payload?.RequestUUID ?? '').trim();
  if (!providerCallId) throw new AppError(400, 'Plivo callback has no call identifier', 'PLIVO_CALL_ID_MISSING');

  return withPlatformAdminContext(null, async (client) => {
    const selected = await client.query(`SELECT c.id, c.ended_at, p.auth_token_encrypted, p.hangup_url,
        COALESCE(parent.auth_token_encrypted,p.auth_token_encrypted) AS main_auth_token_encrypted
      FROM call_sessions c JOIN telephony_accounts p ON p.id=c.telephony_account_id
      LEFT JOIN telephony_accounts parent ON parent.id=p.parent_account_id AND parent.deleted_at IS NULL
      WHERE c.provider_call_id=$1 ORDER BY c.started_at DESC LIMIT 1 FOR UPDATE OF c`, [providerCallId]);
    if (!selected.rowCount) throw new AppError(404, 'Call session was not found', 'CALL_SESSION_NOT_FOUND');
    const call = selected.rows[0];
    if (!call.hangup_url) {
      throw new AppError(503, 'Telephony account Hangup URL is not configured', 'PLIVO_HANGUP_URL_NOT_CONFIGURED');
    }
    if (!validatePlivoAccountSignatures({
      url: call.hangup_url,
      nonce: input.nonce,
      signature: input.signature,
      mainSignature: input.mainSignature,
      authToken: decryptCredential(call.auth_token_encrypted),
      mainAuthToken: decryptCredential(call.main_auth_token_encrypted),
      params: input.payload,
    })) {
      throw new AppError(401, 'Invalid Plivo webhook signature', 'PLIVO_SIGNATURE_INVALID');
    }
    if (call.ended_at) return { duplicate: true, callId: call.id };

    const finalOutcome = outcome(input.payload);
    const status = ['completed', 'failed', 'busy', 'no_answer', 'canceled'].includes(finalOutcome)
      ? finalOutcome : 'failed';
    const duration = Math.max(0, Number(input.payload.BillDuration ?? input.payload.Duration ?? 0));
    await client.query(`UPDATE call_sessions SET status=$2::call_status, ended_at=now(), duration_seconds=$3,
      provider_metadata=provider_metadata||$4::jsonb WHERE id=$1`, [
      call.id, status, duration, JSON.stringify({ plivoHangup: input.payload }),
    ]);
    return { duplicate: false, callId: call.id, status };
  });
}
