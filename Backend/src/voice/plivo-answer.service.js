import { env } from '../config/env.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { validatePlivoSignature } from '../telephony/plivo-webhook.service.js';
import crypto from 'node:crypto';

async function loadCalledNumberAccount(to) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      `SELECT pn.id AS phone_number_id, pn.status AS phone_status, pn.telephony_account_id,
          ta.auth_token_encrypted, ta.status AS account_status
         FROM phone_numbers pn
         JOIN telephony_accounts ta ON ta.id=pn.telephony_account_id
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
  if (!env.PUBLIC_BASE_URL) {
    throw new AppError(503, 'PUBLIC_BASE_URL is not configured', 'PUBLIC_URL_NOT_CONFIGURED');
  }
  const account = await (dependencies.loadCalledNumberAccount ?? loadCalledNumberAccount)(input.payload.To);
  if (account.phone_status !== 'active') {
    throw new AppError(409, 'Called Plivo number is not active', 'PLIVO_CALLED_NUMBER_INACTIVE');
  }
  if (account.account_status !== 'connected') {
    throw new AppError(409, 'Plivo account is not connected', 'PLIVO_ACCOUNT_NOT_CONNECTED');
  }
  const authToken = dependencies.authToken
    ?? decryptCredential(account.auth_token_encrypted);
  const url = `${env.PUBLIC_BASE_URL}/webhooks/plivo/answer`;
  const signatureValid = (dependencies.validateSignature ?? validatePlivoSignature)(
    url,
    input.nonce,
    input.signature,
    authToken,
    input.rawPayload,
  );
  if (!signatureValid) {
    throw new AppError(401, 'Invalid Plivo webhook signature', 'PLIVO_SIGNATURE_INVALID');
  }
  return {
    providerCallId: input.payload.CallUUID,
    from: input.payload.From,
    to: input.payload.To,
    direction: input.payload.Direction ?? 'inbound',
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
    exp: nowSeconds + env.VOICE_MEDIA_TOKEN_TTL_SECONDS,
  });
  const signature = crypto.createHmac('sha256', options.secret ?? mediaSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
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
