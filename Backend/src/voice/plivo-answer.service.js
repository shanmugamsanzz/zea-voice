import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { validatePlivoAccountSignatures } from '../telephony/plivo-webhook.service.js';
import crypto from 'node:crypto';

async function loadCalledNumberAccount(to) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT pn.id AS phone_number_id, pn.status AS phone_status, pn.telephony_account_id,
          ta.auth_token_encrypted, ta.status AS account_status, ta.answer_url,
          COALESCE(parent.auth_token_encrypted,ta.auth_token_encrypted) AS main_auth_token_encrypted
         FROM phone_numbers pn
         JOIN telephony_accounts ta ON ta.id=pn.telephony_account_id
         LEFT JOIN telephony_accounts parent ON parent.id=ta.parent_account_id AND parent.deleted_at IS NULL
        WHERE pn.e164=$1 AND pn.deleted_at IS NULL AND ta.deleted_at IS NULL`,
      [to],
    );
    if (!result.rowCount) {
      throw new AppError(404, 'Called Plivo number is not configured', 'PLIVO_CALLED_NUMBER_NOT_FOUND');
    }
    return result.rows[0];
  });
}

export async function validateIncomingPlivoCall(input, dependencies = {}) {
  const direction = input.payload.Direction ?? 'inbound';
  const platformNumber = direction === 'outbound' ? input.payload.From : input.payload.To;
  const account = await (dependencies.loadCalledNumberAccount ?? loadCalledNumberAccount)(platformNumber);
  if (account.phone_status !== 'active') {
    throw new AppError(409, 'Called Plivo number is not active', 'PLIVO_CALLED_NUMBER_INACTIVE');
  }
  if (account.account_status !== 'connected') {
    throw new AppError(409, 'Plivo account is not connected', 'PLIVO_ACCOUNT_NOT_CONNECTED');
  }
  const answerUrl = dependencies.answerUrl ?? account.answer_url;
  if (!answerUrl) {
    throw new AppError(503, 'Telephony account Answer URL is not configured', 'PLIVO_ANSWER_URL_NOT_CONFIGURED');
  }
  const authToken = dependencies.authToken
    ?? decryptCredential(account.auth_token_encrypted);
  const mainAuthToken = dependencies.mainAuthToken
    ?? (account.main_auth_token_encrypted
      ? decryptCredential(account.main_auth_token_encrypted)
      : authToken);
  const signatureValid = (dependencies.validateSignatures ?? validatePlivoAccountSignatures)({
    url: answerUrl,
    nonce: input.nonce,
    signature: input.signature,
    mainSignature: input.mainSignature,
    authToken,
    mainAuthToken,
    params: input.rawPayload,
  });
  if (!signatureValid) {
    throw new AppError(401, 'Invalid Plivo webhook signature', 'PLIVO_SIGNATURE_INVALID');
  }
  return {
    providerCallId: input.payload.CallUUID,
    from: input.payload.From,
    to: input.payload.To,
    direction,
    callStatus: input.payload.CallStatus ?? null,
    phoneNumberId: account.phone_number_id,
    telephonyAccountId: account.telephony_account_id,
  };
}

function mediaSecret() {
  const secret = env.VOICE_MEDIA_SIGNING_SECRET ?? env.CREDENTIAL_ENCRYPTION_KEY;
  if (!secret) throw new AppError(503, 'Voice media signing is not configured', 'VOICE_MEDIA_SIGNING_NOT_CONFIGURED');
  return secret;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createVoiceMediaToken(callSession, options = {}) {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const payload = encode({
    callId: callSession.id,
    providerCallId: callSession.providerCallId,
    iat: nowSeconds,
    exp: nowSeconds + env.VOICE_MEDIA_TOKEN_TTL_SECONDS,
  });
  const signature = crypto.createHmac('sha256', options.secret ?? mediaSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function validateVoiceMediaToken(token, expectedCallId, options = {}) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError(401, 'Voice media token is invalid', 'VOICE_MEDIA_TOKEN_INVALID');
  }
  const expectedSignature = crypto.createHmac('sha256', options.secret ?? mediaSecret())
    .update(parts[0]).digest('base64url');
  const supplied = Buffer.from(parts[1]);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AppError(401, 'Voice media token signature is invalid', 'VOICE_MEDIA_TOKEN_INVALID');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new AppError(401, 'Voice media token payload is invalid', 'VOICE_MEDIA_TOKEN_INVALID');
  }
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (!payload.callId || !payload.providerCallId || !Number.isInteger(payload.exp)) {
    throw new AppError(401, 'Voice media token payload is incomplete', 'VOICE_MEDIA_TOKEN_INVALID');
  }
  if (payload.exp <= nowSeconds) {
    throw new AppError(401, 'Voice media token has expired', 'VOICE_MEDIA_TOKEN_EXPIRED');
  }
  if (payload.iat && payload.iat > nowSeconds + 30) {
    throw new AppError(401, 'Voice media token is not active', 'VOICE_MEDIA_TOKEN_INVALID');
  }
  if (expectedCallId && payload.callId !== expectedCallId) {
    throw new AppError(401, 'Voice media token does not match the call', 'VOICE_MEDIA_TOKEN_CALL_MISMATCH');
  }
  return payload;
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function buildPlivoStreamXml(callSession, options = {}) {
  if (!env.PUBLIC_BASE_URL) throw new AppError(503, 'PUBLIC_BASE_URL is not configured', 'PUBLIC_URL_NOT_CONFIGURED');
  const base = new URL(env.PUBLIC_BASE_URL);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/webhooks/plivo/media';
  base.search = '';
  base.searchParams.set('call_id', callSession.id);
  base.searchParams.set('token', createVoiceMediaToken(callSession, options));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xmlEscape(base.toString())}</Stream></Response>`;
}
