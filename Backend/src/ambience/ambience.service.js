import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { logger } from '../config/logger.js';
import { deleteAllB2ObjectVersions } from '../rag/b2.client.js';
import { COMPANY_AMBIENCE_LIMIT } from './ambience.schemas.js';

function mapAsset(row) {
  return {
    id: row.id,
    companyId: row.tenant_id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    status: row.status,
    storageStatus: row.storage_status,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    durationMs: row.duration_ms,
    audioMetadata: row.audio_metadata ?? {},
    listeningVolumePercent: row.listening_volume_percent,
    speakingVolumePercent: row.speaking_volume_percent,
    continueDuringSilence: row.continue_during_silence,
    hasSourceAudio: Boolean(row.object_key),
    hasNormalizedAudio: Boolean(row.normalized_object_key),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function writeAudit(client, auth, action, assetId, before, after) {
  await client.query(
    `INSERT INTO audit_logs (
       tenant_id, workspace_id, actor_user_id, actor_type, action,
       entity_type, entity_id, before_data, after_data
     ) VALUES ($1,$2,$3,$4,$5,'company_ambience_asset',$6,$7::jsonb,$8::jsonb)`,
    [auth.tenantId, auth.workspaceId, auth.userId ?? null,
      auth.authType === 'api_key' ? 'api' : 'user', action, assetId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}

async function assetRow(client, auth, assetId, lock = false) {
  const result = await client.query(
    `SELECT * FROM company_ambience_assets
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
      ${lock ? 'FOR UPDATE' : ''}`,
    [auth.tenantId, auth.workspaceId, assetId],
  );
  if (!result.rowCount) throw new AppError(404, 'Ambience asset was not found', 'AMBIENCE_ASSET_NOT_FOUND');
  return result.rows[0];
}

function duplicateError(error) {
  return error?.code === '23505'
    ? new AppError(409, 'An ambience asset with this name already exists in the workspace', 'AMBIENCE_ASSET_EXISTS')
    : error;
}

export function listAmbienceAssets(auth, filters, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const offset = (filters.page - 1) * filters.pageSize;
    const values = [auth.tenantId, auth.workspaceId];
    const clauses = ['tenant_id=$1', 'workspace_id=$2', 'deleted_at IS NULL'];
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(`name ILIKE $${values.length}`);
    }
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`status=$${values.length}`);
    }
    values.push(filters.pageSize, offset);
    const result = await client.query(
      `SELECT *, count(*) OVER()::int AS total_count
         FROM company_ambience_assets
        WHERE ${clauses.join(' AND ')}
        ORDER BY lower(name), id
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      items: result.rows.map(mapAsset),
      limits: { maximum: COMPANY_AMBIENCE_LIMIT, used: total, remaining: Math.max(0, COMPANY_AMBIENCE_LIMIT - total) },
      pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.ceil(total / filters.pageSize) },
    };
  });
}

export function getAmbienceAsset(auth, assetId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => mapAsset(await assetRow(client, auth, assetId)));
}

export function createAmbienceAsset(auth, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ambience:${auth.tenantId}:${auth.workspaceId}`]);
    const count = await client.query(
      `SELECT count(*)::int AS count FROM company_ambience_assets
        WHERE tenant_id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
      [auth.tenantId, auth.workspaceId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= COMPANY_AMBIENCE_LIMIT) {
      throw new AppError(409, `A workspace can maintain up to ${COMPANY_AMBIENCE_LIMIT} ambience assets`, 'AMBIENCE_ASSET_LIMIT_REACHED');
    }
    try {
      const inserted = await client.query(
        `INSERT INTO company_ambience_assets (
           tenant_id, workspace_id, name, description, status,
           listening_volume_percent, speaking_volume_percent, continue_during_silence,
           created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [auth.tenantId, auth.workspaceId, input.name, input.description, input.status,
          input.listeningVolumePercent, input.speakingVolumePercent, input.continueDuringSilence,
          auth.userId ?? null],
      );
      const asset = mapAsset(await assetRow(client, auth, inserted.rows[0].id));
      await writeAudit(client, auth, 'AMBIENCE_ASSET_CREATED', asset.id, null, asset);
      return asset;
    } catch (error) {
      throw duplicateError(error);
    }
  });
}

export function updateAmbienceAsset(auth, assetId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const beforeRow = await assetRow(client, auth, assetId, true);
    const before = mapAsset(beforeRow);
    const next = {
      name: input.name ?? beforeRow.name,
      description: Object.hasOwn(input, 'description') ? input.description : beforeRow.description,
      status: input.status ?? beforeRow.status,
      listeningVolumePercent: input.listeningVolumePercent ?? beforeRow.listening_volume_percent,
      speakingVolumePercent: input.speakingVolumePercent ?? beforeRow.speaking_volume_percent,
      continueDuringSilence: input.continueDuringSilence ?? beforeRow.continue_during_silence,
    };
    try {
      await client.query(
        `UPDATE company_ambience_assets
            SET name=$4, description=$5, status=$6, listening_volume_percent=$7,
                speaking_volume_percent=$8, continue_during_silence=$9, updated_by=$10
          WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [auth.tenantId, auth.workspaceId, assetId, next.name, next.description, next.status,
          next.listeningVolumePercent, next.speakingVolumePercent, next.continueDuringSilence,
          auth.userId ?? null],
      );
    } catch (error) {
      throw duplicateError(error);
    }
    const after = mapAsset(await assetRow(client, auth, assetId));
    await writeAudit(client, auth, 'AMBIENCE_ASSET_UPDATED', assetId, before, after);
    return after;
  });
}

export async function deleteAmbienceAsset(
  auth,
  assetId,
  contextRunner = withTenantContext,
  storageAdapter = { deleteAllVersions: deleteAllB2ObjectVersions },
) {
  const deleted = await contextRunner(auth, async (client) => {
    const beforeRow = await assetRow(client, auth, assetId, true);
    const before = mapAsset(beforeRow);
    const assigned = await client.query(
      `SELECT count(*)::int AS count FROM agent_ambience_assignments
        WHERE tenant_id=$1 AND workspace_id=$2 AND ambience_asset_id=$3`,
      [auth.tenantId, auth.workspaceId, assetId],
    );
    if (Number(assigned.rows[0]?.count ?? 0) > 0) {
      throw new AppError(
        409,
        'This ambience is assigned to an agent. Select Silent or another ambience on that agent before deleting it.',
        'AMBIENCE_ASSET_ASSIGNED',
      );
    }
    await client.query(
      `UPDATE company_ambience_assets
          SET status='archived', updated_by=$4, deleted_at=now()
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
      [auth.tenantId, auth.workspaceId, assetId, auth.userId ?? null],
    );
    await writeAudit(client, auth, 'AMBIENCE_ASSET_DELETED', assetId, before, null);
    return {
      result: { id: assetId, deleted: true },
      privateObjectKeys: [...new Set([beforeRow.object_key, beforeRow.normalized_object_key].filter(Boolean))],
    };
  });
  let storageCleanupRequired = false;
  for (const key of deleted.privateObjectKeys) {
    await storageAdapter.deleteAllVersions({ key }).catch((error) => {
      storageCleanupRequired = true;
      logger.warn({ err: error, assetId }, 'Deleted ambience metadata but private B2 cleanup must be retried');
    });
  }
  return { ...deleted.result, storageCleanupRequired };
}
