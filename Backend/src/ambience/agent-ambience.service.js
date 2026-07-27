import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

function mapAssignment(row) {
  if (!row) return { ambienceAssetId: null, asset: null };
  return {
    ambienceAssetId: row.ambience_asset_id,
    assignedAt: row.assignment_updated_at,
    asset: {
      id: row.ambience_asset_id,
      name: row.name,
      description: row.description,
      status: row.status,
      storageStatus: row.storage_status,
      originalFileName: row.original_file_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      durationMs: row.duration_ms,
      listeningVolumePercent: row.listening_volume_percent,
      speakingVolumePercent: row.speaking_volume_percent,
      continueDuringSilence: row.continue_during_silence,
    },
  };
}

async function assertAgent(client, auth, agentId) {
  const result = await client.query(
    `SELECT 1 FROM voice_agents
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        AND status <> 'archived' AND deleted_at IS NULL`,
    [auth.tenantId, auth.workspaceId, agentId],
  );
  if (!result.rowCount) throw new AppError(404, 'Agent was not found in this workspace', 'AGENT_NOT_FOUND');
}

async function assignmentRow(client, auth, agentId) {
  const result = await client.query(
    `SELECT aa.ambience_asset_id, aa.updated_at AS assignment_updated_at,
            a.name, a.description, a.status, a.storage_status, a.original_file_name,
            a.mime_type, a.size_bytes, a.duration_ms, a.listening_volume_percent,
            a.speaking_volume_percent, a.continue_during_silence
       FROM agent_ambience_assignments aa
       JOIN company_ambience_assets a
         ON a.tenant_id=aa.tenant_id AND a.workspace_id=aa.workspace_id
        AND a.id=aa.ambience_asset_id
      WHERE aa.tenant_id=$1 AND aa.workspace_id=$2 AND aa.agent_id=$3`,
    [auth.tenantId, auth.workspaceId, agentId],
  );
  return result.rows[0] ?? null;
}

export function getAgentAmbienceAssignment(auth, agentId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await assertAgent(client, auth, agentId);
    return mapAssignment(await assignmentRow(client, auth, agentId));
  });
}

export function replaceAgentAmbienceAssignment(auth, agentId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await assertAgent(client, auth, agentId);
    if (input.ambienceAssetId === null) {
      await client.query(
        `DELETE FROM agent_ambience_assignments
          WHERE tenant_id=$1 AND workspace_id=$2 AND agent_id=$3`,
        [auth.tenantId, auth.workspaceId, agentId],
      );
      return { ambienceAssetId: null, asset: null };
    }

    const asset = await client.query(
      `SELECT 1 FROM company_ambience_assets
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
          AND status='active' AND storage_status='ready'
          AND object_key IS NOT NULL AND normalized_object_key IS NOT NULL`,
      [auth.tenantId, auth.workspaceId, input.ambienceAssetId],
    );
    if (!asset.rowCount) {
      throw new AppError(
        409,
        'Only an active ambience asset with a completed audio upload can be assigned',
        'AMBIENCE_ASSET_NOT_ASSIGNABLE',
      );
    }
    await client.query(
      `INSERT INTO agent_ambience_assignments (
         tenant_id, workspace_id, agent_id, ambience_asset_id, assigned_by
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, workspace_id, agent_id) DO UPDATE
         SET ambience_asset_id=EXCLUDED.ambience_asset_id,
             assigned_by=EXCLUDED.assigned_by,
             updated_at=now()`,
      [auth.tenantId, auth.workspaceId, agentId, input.ambienceAssetId, auth.userId ?? null],
    );
    return mapAssignment(await assignmentRow(client, auth, agentId));
  });
}
