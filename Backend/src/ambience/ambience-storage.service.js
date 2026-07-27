import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { checkB2, deleteAllB2ObjectVersions, getB2Object, putB2Object } from '../rag/b2.client.js';
import { ambienceSourceObjectKey, validateAmbienceAudioFile } from './ambience-audio-validation.js';
import {
  ambienceNormalizedObjectKey,
  normalizeAmbienceAudio,
} from './ambience-preprocessor.js';

const storage = {
  putObject: putB2Object,
  getObject: getB2Object,
  deleteAllVersions: deleteAllB2ObjectVersions,
  verifyPrivate: checkB2,
};

let privateStorageVerification;
let privateStorageVerifiedUntil = 0;

function ensureB2Configured(configuration) {
  if (!configuration.B2_BUCKET || !configuration.B2_BUCKET_ID || !configuration.B2_REGION
    || !configuration.B2_S3_ENDPOINT || !configuration.B2_KEY_ID || !configuration.B2_APPLICATION_KEY) {
    throw new AppError(503, 'Private B2 ambience storage is not configured', 'AMBIENCE_B2_NOT_CONFIGURED');
  }
}

async function verifyPrivateStorage(storageAdapter) {
  if (typeof storageAdapter.verifyPrivate !== 'function') return;
  if (Date.now() < privateStorageVerifiedUntil) return;
  privateStorageVerification ??= Promise.resolve(storageAdapter.verifyPrivate())
    .then(() => { privateStorageVerifiedUntil = Date.now() + 300_000; })
    .finally(() => { privateStorageVerification = null; });
  try {
    await privateStorageVerification;
  } catch (error) {
    logger.error({ err: error }, 'Ambience upload rejected because B2 privacy could not be verified');
    throw new AppError(503, 'Private B2 ambience storage could not be verified', 'AMBIENCE_B2_PRIVACY_UNVERIFIED');
  }
}

async function ownedAsset(client, auth, assetId, lock = false) {
  const result = await client.query(
    `SELECT * FROM company_ambience_assets
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
      ${lock ? 'FOR UPDATE' : ''}`,
    [auth.tenantId, auth.workspaceId, assetId],
  );
  if (!result.rowCount) throw new AppError(404, 'Ambience asset was not found', 'AMBIENCE_ASSET_NOT_FOUND');
  if (result.rows[0].status === 'archived') {
    throw new AppError(409, 'Archived ambience assets cannot receive audio', 'AMBIENCE_ASSET_ARCHIVED');
  }
  return result.rows[0];
}

function publicUploadResult(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    storageStatus: row.storage_status,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    durationMs: row.duration_ms,
    audioMetadata: row.audio_metadata ?? {},
    hasSourceAudio: Boolean(row.object_key),
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
  };
}

async function recordUploadFailure(auth, assetId, uploadToken, error, contextRunner) {
  await contextRunner(auth, (client) => client.query(
    `UPDATE company_ambience_assets
        SET storage_status='failed', storage_error_code=$5, storage_error_message=$6,
            upload_token=NULL, updated_by=$7
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND upload_token=$4 AND deleted_at IS NULL`,
    [auth.tenantId, auth.workspaceId, assetId, uploadToken, 'B2_UPLOAD_FAILED',
      String(error?.message ?? error).slice(0, 1000), auth.userId ?? null],
  )).catch((updateError) => logger.warn({ err: updateError, assetId }, 'Could not record ambience upload failure'));
}

export async function uploadAmbienceAudio(
  auth,
  assetId,
  file,
  storageAdapter = storage,
  contextRunner = withTenantContext,
  configuration = env,
  processor = normalizeAmbienceAudio,
) {
  ensureB2Configured(configuration);
  await verifyPrivateStorage(storageAdapter);
  const audio = validateAmbienceAudioFile(file);
  const uploadToken = crypto.randomUUID();
  const reservation = await contextRunner(auth, async (client) => {
    const asset = await ownedAsset(client, auth, assetId, true);
    if (asset.checksum_sha256 === audio.checksumSha256) {
      throw new AppError(409, 'This audio is identical to the current ambience file', 'AMBIENCE_AUDIO_UNCHANGED');
    }
    const duplicate = await client.query(
      `SELECT id FROM company_ambience_assets
        WHERE tenant_id=$1 AND workspace_id=$2 AND checksum_sha256=$3
          AND id<>$4 AND deleted_at IS NULL
        LIMIT 1`,
      [auth.tenantId, auth.workspaceId, audio.checksumSha256, assetId],
    );
    if (duplicate.rowCount) {
      throw new AppError(409, 'This audio file already exists in the workspace', 'AMBIENCE_AUDIO_DUPLICATE');
    }
    await client.query(
      `UPDATE company_ambience_assets
          SET storage_status='pending', storage_error_code=NULL, storage_error_message=NULL,
              upload_token=$4, updated_by=$5
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
      [auth.tenantId, auth.workspaceId, assetId, uploadToken, auth.userId ?? null],
    );
    return {
      oldObjectKey: asset.object_key,
      oldNormalizedObjectKey: asset.normalized_object_key,
      objectKey: ambienceSourceObjectKey({
        tenantId: auth.tenantId, workspaceId: auth.workspaceId, assetId,
        checksumSha256: audio.checksumSha256, extension: audio.extension,
      }),
      normalizedObjectKey: ambienceNormalizedObjectKey({
        tenantId: auth.tenantId, workspaceId: auth.workspaceId, assetId,
        checksumSha256: audio.checksumSha256,
      }),
      uploadToken,
    };
  });

  let stored;
  let normalizedStored;
  try {
    const normalized = await processor(file.buffer, {
      timeoutMs: configuration.AMBIENCE_PREPROCESS_TIMEOUT_MS,
      maxOutputBytes: Math.ceil((audio.durationMs / 1000) * 8000) + 8000,
    });
    const expectedBytes = Math.round((audio.durationMs / 1000) * 8000);
    if (Math.abs(normalized.length - expectedBytes) > 16000) {
      throw new AppError(400, 'Normalized ambience duration does not match the uploaded audio', 'AMBIENCE_NORMALIZED_DURATION_MISMATCH');
    }
    stored = await storageAdapter.putObject({
      key: reservation.objectKey,
      body: file.buffer,
      contentType: audio.mimeType,
      metadata: {
        tenant_id: auth.tenantId,
        workspace_id: auth.workspaceId,
        ambience_asset_id: assetId,
        checksum_sha256: audio.checksumSha256,
        duration_ms: audio.durationMs,
      },
    });
    normalizedStored = await storageAdapter.putObject({
      key: reservation.normalizedObjectKey,
      body: normalized,
      contentType: 'audio/x-mulaw',
      metadata: {
        tenant_id: auth.tenantId,
        workspace_id: auth.workspaceId,
        ambience_asset_id: assetId,
        source_checksum_sha256: audio.checksumSha256,
        audio_encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
      },
    });
    normalizedStored.sizeBytes = normalized.length;
  } catch (error) {
    if (stored) await storageAdapter.deleteAllVersions({ key: reservation.objectKey }).catch(() => {});
    if (normalizedStored) await storageAdapter.deleteAllVersions({ key: reservation.normalizedObjectKey }).catch(() => {});
    await recordUploadFailure(auth, assetId, reservation.uploadToken, error, contextRunner);
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'Ambience audio could not be preprocessed and stored in private B2 storage', 'AMBIENCE_B2_UPLOAD_FAILED');
  }

  let saved;
  try {
    saved = await contextRunner(auth, async (client) => {
      await ownedAsset(client, auth, assetId, true);
      const result = await client.query(
        `UPDATE company_ambience_assets
            SET storage_status='ready', original_file_name=$4, object_key=$5,
                normalized_object_key=$6, mime_type=$7, size_bytes=$8, duration_ms=$9,
                checksum_sha256=$10, audio_metadata=$11::jsonb, storage_version_id=$12,
                storage_etag=$13, normalized_storage_version_id=$14,
                normalized_storage_etag=$15, normalized_size_bytes=$16, normalized_at=now(),
                storage_error_code=NULL, storage_error_message=NULL,
                upload_token=NULL, uploaded_at=now(), updated_by=$17
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
            AND upload_token=$18 AND deleted_at IS NULL
          RETURNING *`,
        [auth.tenantId, auth.workspaceId, assetId, audio.originalFileName, reservation.objectKey,
          reservation.normalizedObjectKey, audio.mimeType, audio.sizeBytes, audio.durationMs, audio.checksumSha256,
          JSON.stringify({ type: audio.type, sampleRate: audio.sampleRate, channels: audio.channels,
            bitsPerSample: audio.bitsPerSample ?? null, frameCount: audio.frameCount ?? null,
            runtimeFormat: { encoding: 'mulaw', sampleRate: 8000, channels: 1 } }),
          stored.storageVersionId ?? null, stored.etag ?? null,
          normalizedStored.storageVersionId ?? null, normalizedStored.etag ?? null,
          normalizedStored.sizeBytes, auth.userId ?? null, reservation.uploadToken],
      );
      if (!result.rowCount) throw new AppError(409, 'Ambience asset was deleted while audio was uploading', 'AMBIENCE_ASSET_UPLOAD_CANCELLED');
      const publicResult = publicUploadResult(result.rows[0]);
      await client.query(
        `INSERT INTO audit_logs (
           tenant_id, workspace_id, actor_user_id, actor_type, action,
           entity_type, entity_id, after_data
         ) VALUES ($1,$2,$3,$4,'AMBIENCE_AUDIO_UPLOADED','company_ambience_asset',$5,$6::jsonb)`,
        [auth.tenantId, auth.workspaceId, auth.userId ?? null,
          auth.authType === 'api_key' ? 'api' : 'user', assetId,
          JSON.stringify({ checksumSha256: audio.checksumSha256, sizeBytes: audio.sizeBytes,
            durationMs: audio.durationMs, mimeType: audio.mimeType })],
      );
      return publicResult;
    });
  } catch (error) {
    await storageAdapter.deleteAllVersions({ key: reservation.objectKey }).catch((cleanupError) => {
      logger.error({ err: cleanupError, assetId }, 'Orphaned ambience B2 object could not be removed');
    });
    await storageAdapter.deleteAllVersions({ key: reservation.normalizedObjectKey }).catch((cleanupError) => {
      logger.error({ err: cleanupError, assetId }, 'Orphaned normalized ambience B2 object could not be removed');
    });
    if (error?.code === '23505') {
      throw new AppError(409, 'This audio file already exists in the workspace', 'AMBIENCE_AUDIO_DUPLICATE');
    }
    throw error;
  }

  const obsoleteKeys = [...new Set([reservation.oldObjectKey, reservation.oldNormalizedObjectKey]
    .filter((key) => key && key !== reservation.objectKey))];
  for (const key of obsoleteKeys) {
    await storageAdapter.deleteAllVersions({ key }).catch((error) => {
      logger.warn({ err: error, assetId }, 'Replaced ambience B2 object remains queued for cleanup');
    });
  }
  return saved;
}

export async function getAmbienceAudio(
  auth,
  assetId,
  storageAdapter = storage,
  contextRunner = withTenantContext,
  configuration = env,
) {
  ensureB2Configured(configuration);
  await verifyPrivateStorage(storageAdapter);
  const asset = await contextRunner(auth, async (client) => {
    const row = await ownedAsset(client, auth, assetId);
    if (row.storage_status !== 'ready' || !row.object_key) {
      throw new AppError(409, 'Ambience audio is not ready', 'AMBIENCE_AUDIO_NOT_READY');
    }
    return { key: row.object_key, versionId: row.storage_version_id, fileName: row.original_file_name, mimeType: row.mime_type };
  });
  try {
    const object = await storageAdapter.getObject({
      key: asset.key,
      versionId: asset.versionId ?? undefined,
      maxBytes: configuration.AMBIENCE_AUDIO_MAX_BYTES,
    });
    return { body: object.body, mimeType: asset.mimeType ?? object.contentType ?? 'application/octet-stream', fileName: asset.fileName };
  } catch (error) {
    logger.warn({ err: error, assetId }, 'Private ambience audio could not be read from B2');
    throw new AppError(502, 'Ambience audio could not be read from private storage', 'AMBIENCE_B2_READ_FAILED');
  }
}
