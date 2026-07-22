import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { getQueue } from '../queues/queue.registry.js';
import { getB2Object, putB2Object } from '../rag/b2.client.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { validatePlivoAccountSignatures } from './plivo-webhook.service.js';

function basicAuth(authId, authToken) {
  return `Basic ${Buffer.from(`${authId}:${authToken}`).toString('base64')}`;
}

function callbackUrl(baseUrl, callId) {
  const url = new URL(baseUrl);
  url.searchParams.set('call_id', callId);
  return url.toString();
}

async function recordingContext(callId) {
  return withPlatformAdminContext(null, async (client) => {
    const result = await client.query(`SELECT c.*, a.auth_id, a.auth_token_encrypted,
        a.recording_callback_url,
        COALESCE(parent.auth_id,a.auth_id) AS main_auth_id,
        COALESCE(parent.auth_token_encrypted,a.auth_token_encrypted) AS main_auth_token_encrypted
      FROM call_sessions c
      JOIN telephony_accounts a ON a.id=c.telephony_account_id AND a.deleted_at IS NULL
      LEFT JOIN telephony_accounts parent ON parent.id=a.parent_account_id AND parent.deleted_at IS NULL
      WHERE c.id=$1`, [callId]);
    if (!result.rowCount) throw new AppError(404, 'Call session was not found', 'CALL_SESSION_NOT_FOUND');
    return result.rows[0];
  });
}

function recordingPayload(payload) {
  return {
    id: String(payload.RecordingID ?? '').trim(),
    url: String(payload.RecordUrl ?? payload.RecordingURL ?? '').trim(),
    durationMs: Math.max(0, Number(payload.RecordingDurationMs ?? 0) || 0),
    providerCallId: String(payload.CallUUID ?? '').trim() || null,
  };
}

export async function acceptPlivoRecordingCallback(input, dependencies = {}) {
  const call = await (dependencies.loadContext ?? recordingContext)(input.callId);
  if (!call.recording_callback_url) {
    throw new AppError(503, 'Recording Callback URL is not configured', 'PLIVO_RECORDING_CALLBACK_NOT_CONFIGURED');
  }
  const url = callbackUrl(call.recording_callback_url, input.callId);
  const valid = (dependencies.validateSignatures ?? validatePlivoAccountSignatures)({
    url, nonce: input.nonce, signature: input.signature, mainSignature: input.mainSignature,
    authToken: decryptCredential(call.auth_token_encrypted),
    mainAuthToken: decryptCredential(call.main_auth_token_encrypted), params: input.payload,
  });
  if (!valid) throw new AppError(401, 'Invalid Plivo recording signature', 'PLIVO_SIGNATURE_INVALID');

  const recording = recordingPayload(input.payload);
  if (!recording.id || !recording.url) {
    throw new AppError(400, 'Plivo recording callback is incomplete', 'PLIVO_RECORDING_CALLBACK_INVALID');
  }
  let parsedUrl;
  try { parsedUrl = new URL(recording.url); } catch {
    throw new AppError(400, 'Plivo recording URL is invalid', 'PLIVO_RECORDING_URL_INVALID');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new AppError(400, 'Plivo recording URL must use HTTPS', 'PLIVO_RECORDING_URL_INVALID');
  }
  if (recording.providerCallId && call.provider_call_id
    && recording.providerCallId !== call.provider_call_id) {
    throw new AppError(409, 'Recording does not belong to this call', 'PLIVO_RECORDING_CALL_MISMATCH');
  }

  const savePending = dependencies.savePending ?? ((operation) => withPlatformAdminContext(null, operation));
  const state = await savePending(async (client) => {
    const locked = await client.query('SELECT recording_object_key,provider_metadata FROM call_sessions WHERE id=$1 FOR UPDATE', [input.callId]);
    const previous = locked.rows[0]?.provider_metadata?.recording;
    if (locked.rows[0]?.recording_object_key && previous?.id === recording.id) return 'stored';
    if (previous?.id && previous.id !== recording.id) {
      throw new AppError(409, 'A different recording is already attached to this call', 'CALL_RECORDING_CONFLICT');
    }
    await client.query(`UPDATE call_sessions SET provider_metadata=jsonb_set(
      COALESCE(provider_metadata,'{}'::jsonb),'{recording}',$2::jsonb,true) WHERE id=$1`, [input.callId,
      JSON.stringify({ ...recording, status: 'pending', receivedAt: new Date().toISOString() })]);
    return previous?.status === 'pending' || previous?.status === 'processing' ? 'duplicate' : 'accepted';
  });
  if (state === 'stored') return { accepted: true, duplicate: true, status: 'stored' };

  const queue = dependencies.queue ?? getQueue('recording-processing');
  if (!queue) throw new AppError(503, 'Recording processing queue is unavailable', 'RECORDING_QUEUE_UNAVAILABLE');
  await queue.add('store-recording', { callId: input.callId }, {
    jobId: `recording-${input.callId}-${crypto.createHash('sha256').update(recording.id).digest('hex').slice(0, 32)}`,
    attempts: 5, backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000, removeOnFail: 5000,
  });
  logger.info({ stage: 'recording.callback_accepted', callId: input.callId, recordingId: recording.id },
    'Plivo recording callback accepted');
  return { accepted: true, duplicate: state === 'duplicate', status: 'queued' };
}

async function download(url, credentials, fetchImpl) {
  const attempt = async ({ authId, authToken }) => fetchImpl(url, {
    headers: { authorization: basicAuth(authId, authToken), accept: 'audio/mpeg,audio/wav,audio/*' },
    redirect: 'follow', signal: AbortSignal.timeout(env.VOICE_RECORDING_DOWNLOAD_TIMEOUT_MS),
  });
  let response = await attempt(credentials.associated);
  if ([401, 403].includes(response.status) && credentials.main.authId !== credentials.associated.authId) {
    response = await attempt(credentials.main);
  }
  if (!response.ok) throw new Error(`Plivo recording download failed with HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > env.VOICE_RECORDING_MAX_BYTES) throw new Error('Plivo recording exceeds the configured size limit');
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length || body.length > env.VOICE_RECORDING_MAX_BYTES) throw new Error('Plivo recording size is invalid');
  const isWav = body.length >= 12 && body.subarray(0, 4).toString() === 'RIFF'
    && body.subarray(8, 12).toString() === 'WAVE';
  const isMp3 = body.subarray(0, 3).toString() === 'ID3'
    || (body.length >= 2 && body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
  if (!isWav && !isMp3) throw new Error('Downloaded file is not a supported Plivo audio recording');
  return { body, contentType: isWav ? 'audio/wav' : 'audio/mpeg', extension: isWav ? 'wav' : 'mp3' };
}

export async function processPlivoRecording(callId, dependencies = {}) {
  const call = await (dependencies.loadContext ?? recordingContext)(callId);
  const recording = call.provider_metadata?.recording;
  if (!recording?.id || !recording?.url) throw new Error('Pending recording metadata was not found');
  if (call.recording_object_key && recording.status === 'stored') return { duplicate: true, key: call.recording_object_key };
  const updateState = dependencies.updateState ?? ((operation) => withPlatformAdminContext(null, operation));
  await updateState((client) => client.query(`UPDATE call_sessions
    SET provider_metadata=jsonb_set(provider_metadata,'{recording,status}','"processing"'::jsonb,true)
    WHERE id=$1`, [callId]));
  try {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const audio = await download(recording.url, {
      associated: { authId: call.auth_id, authToken: decryptCredential(call.auth_token_encrypted) },
      main: { authId: call.main_auth_id, authToken: decryptCredential(call.main_auth_token_encrypted) },
    }, fetchImpl);
    const safeRecordingId = recording.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 240);
    const key = `recordings/${call.tenant_id}/${call.workspace_id}/${call.id}/${safeRecordingId}.${audio.extension}`;
    const checksum = crypto.createHash('sha256').update(audio.body).digest('hex');
    await (dependencies.putObject ?? putB2Object)({
      key, body: audio.body, contentType: audio.contentType,
      metadata: { tenantId: call.tenant_id, workspaceId: call.workspace_id, callId: call.id,
        recordingId: recording.id, checksumSha256: checksum },
    });
    await updateState((client) => client.query(`UPDATE call_sessions SET
      recording_object_key=$2,
      provider_metadata=jsonb_set(provider_metadata,'{recording}',$3::jsonb,true) WHERE id=$1`, [callId, key,
      JSON.stringify({ id: recording.id, status: 'stored', durationMs: recording.durationMs,
        contentType: audio.contentType, sizeBytes: audio.body.length, checksumSha256: checksum,
        storedAt: new Date().toISOString() })]));
    logger.info({ stage: 'recording.stored', callId, recordingId: recording.id,
      sizeBytes: audio.body.length }, 'Call recording stored privately in B2');
    return { duplicate: false, key, sizeBytes: audio.body.length, contentType: audio.contentType };
  } catch (error) {
    await updateState((client) => client.query(`UPDATE call_sessions SET
      provider_metadata=jsonb_set(jsonb_set(provider_metadata,'{recording,status}','"failed"'::jsonb,true),
        '{recording,error}',$2::jsonb,true) WHERE id=$1`, [callId, JSON.stringify(String(error.message).slice(0, 500))])).catch(() => {});
    throw error;
  }
}

export async function loadStoredCallRecording(auth, callId, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? ((operation) => (auth.role === 'SUPER_ADMIN'
    ? withPlatformAdminContext(auth.userId, operation) : withTenantContext(auth, operation)));
  const call = await contextRunner(async (client) => {
    const result = await client.query(`SELECT id,tenant_id,recording_object_key,provider_metadata
      FROM call_sessions WHERE id=$1 AND ($2::boolean OR tenant_id=$3)`,
    [callId, auth.role === 'SUPER_ADMIN', auth.tenantId ?? null]);
    if (!result.rowCount) throw new AppError(404, 'Call was not found', 'CALL_NOT_FOUND');
    if (!result.rows[0].recording_object_key) throw new AppError(404, 'Call recording is not available', 'CALL_RECORDING_NOT_FOUND');
    return result.rows[0];
  });
  try {
    return await (dependencies.getObject ?? getB2Object)({ key: call.recording_object_key, maxBytes: env.VOICE_RECORDING_MAX_BYTES });
  } catch (error) {
    throw new AppError(502, 'Call recording could not be loaded from storage', 'CALL_RECORDING_STORAGE_FAILED');
  }
}
