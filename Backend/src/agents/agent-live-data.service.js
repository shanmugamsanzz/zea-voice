import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { deleteAgentLiveDataTableIndex, syncAgentLiveDataTable } from './agent-live-data-index.service.js';

function keyFromName(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'column';
}

async function requireAgent(client, tenantId, agentId) {
  const result = await client.query(
    'SELECT id, workspace_id FROM voice_agents WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL',
    [tenantId, agentId],
  );
  if (!result.rowCount) throw new AppError(404, 'Voice agent was not found', 'AGENT_NOT_FOUND');
  return result.rows[0];
}

async function requireTable(client, tenantId, agentId, tableId) {
  const result = await client.query(
    `SELECT id, tenant_id, workspace_id, agent_id, name, created_at, updated_at
     FROM agent_live_data_tables WHERE tenant_id=$1 AND agent_id=$2 AND id=$3`,
    [tenantId, agentId, tableId],
  );
  if (!result.rowCount) throw new AppError(404, 'Live Data table was not found', 'LIVE_DATA_TABLE_NOT_FOUND');
  return result.rows[0];
}

async function tableView(client, tenantId, agentId, tableId) {
  const result = await client.query(
    `SELECT t.id, t.name, t.sync_status, t.sync_error, t.synced_at, t.created_at, t.updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'key', c.column_key, 'dataType', c.data_type,
        'position', c.position, 'createdAt', c.created_at, 'updatedAt', c.updated_at
      ) ORDER BY c.position, c.created_at) FROM agent_live_data_columns c
        WHERE c.tenant_id=t.tenant_id AND c.table_id=t.id), '[]'::jsonb) AS columns,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'values', r.row_values, 'createdAt', r.created_at, 'updatedAt', r.updated_at
      ) ORDER BY r.created_at) FROM agent_live_data_rows r
        WHERE r.tenant_id=t.tenant_id AND r.table_id=t.id), '[]'::jsonb) AS rows
     FROM agent_live_data_tables t
     WHERE t.tenant_id=$1 AND t.agent_id=$2 AND t.id=$3`,
    [tenantId, agentId, tableId],
  );
  if (!result.rowCount) throw new AppError(404, 'Live Data table was not found', 'LIVE_DATA_TABLE_NOT_FOUND');
  const row = result.rows[0];
  return { id: row.id, name: row.name, columns: row.columns, rows: row.rows,
    sync: { status: row.sync_status, error: row.sync_error, syncedAt: row.synced_at },
    createdAt: row.created_at, updatedAt: row.updated_at };
}

async function markTableSync(auth, agentId, tableId, status, error = null) {
  return withTenantContext(auth, async (client) => {
    await client.query(
      `UPDATE agent_live_data_tables
       SET sync_status=$4::varchar, sync_error=$5::varchar,
           synced_at=CASE WHEN $4::varchar='synced'::varchar THEN now() ELSE synced_at END
       WHERE tenant_id=$1 AND agent_id=$2 AND id=$3`,
      [auth.tenantId, agentId, tableId, status, error],
    );
  });
}

async function synchronizeAfterChange(auth, agentId, tableId) {
  await markTableSync(auth, agentId, tableId, 'syncing');
  try {
    await syncAgentLiveDataTable(auth, agentId, tableId);
    await markTableSync(auth, agentId, tableId, 'synced');
  } catch (error) {
    await markTableSync(auth, agentId, tableId, 'failed', String(error?.message ?? 'Live Data index sync failed').slice(0, 500));
  }
  return withTenantContext(auth, (client) => tableView(client, auth.tenantId, agentId, tableId));
}

async function audit(client, auth, action, entityId, afterData = {}) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
     VALUES ($1,$2,$3,'user',$4,'agent_live_data',$5,$6::jsonb)`,
    [auth.tenantId, auth.workspaceId, auth.userId, action, entityId, JSON.stringify(afterData)],
  );
}

function normalizedValues(values, columns) {
  const allowed = new Map(columns.map((column) => [column.column_key, column]));
  const result = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const column = allowed.get(key);
    if (!column) throw new AppError(400, `Unknown Live Data column: ${key}`, 'LIVE_DATA_UNKNOWN_COLUMN');
    if (value === null) { result[key] = null; continue; }
    if (column.data_type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new AppError(400, `${column.name} must be a number`, 'LIVE_DATA_VALUE_INVALID');
    }
    if (column.data_type === 'boolean' && typeof value !== 'boolean') {
      throw new AppError(400, `${column.name} must be true or false`, 'LIVE_DATA_VALUE_INVALID');
    }
    result[key] = value;
  }
  return result;
}

async function columnsForTable(client, tenantId, tableId) {
  return (await client.query(
    'SELECT id, name, column_key, data_type, position FROM agent_live_data_columns WHERE tenant_id=$1 AND table_id=$2 ORDER BY position, created_at',
    [tenantId, tableId],
  )).rows;
}

export function listLiveDataTables(auth, agentId) {
  return withTenantContext(auth, async (client) => {
    await requireAgent(client, auth.tenantId, agentId);
    const tables = await client.query(
      'SELECT id FROM agent_live_data_tables WHERE tenant_id=$1 AND agent_id=$2 ORDER BY created_at',
      [auth.tenantId, agentId],
    );
    return Promise.all(tables.rows.map(({ id }) => tableView(client, auth.tenantId, agentId, id)));
  });
}

export function listLiveDataHistory(auth, agentId, tableId) {
  return withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    const result = await client.query(
      `SELECT id, action, actor_user_id, created_at, after_data
       FROM audit_logs
       WHERE tenant_id=$1 AND entity_type='agent_live_data'
         AND (entity_id=$2 OR after_data->>'tableId'=$2)
       ORDER BY created_at DESC LIMIT 50`,
      [auth.tenantId, tableId],
    );
    return result.rows.map((row) => ({
      id: row.id, action: row.action, actorUserId: row.actor_user_id,
      createdAt: row.created_at, details: row.after_data,
    }));
  });
}

export async function createLiveDataTable(auth, agentId, input) {
  const tableId = await withTenantContext(auth, async (client) => {
    const agent = await requireAgent(client, auth.tenantId, agentId);
    try {
      const result = await client.query(
        `INSERT INTO agent_live_data_tables (tenant_id, workspace_id, agent_id, name, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
        [auth.tenantId, agent.workspace_id, agentId, input.name, auth.userId],
      );
      await audit(client, auth, 'AGENT_LIVE_DATA_TABLE_CREATED', result.rows[0].id, { agentId, name: input.name });
      return result.rows[0].id;
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'A Live Data table with this name already exists for the agent', 'LIVE_DATA_TABLE_EXISTS');
      throw error;
    }
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function updateLiveDataTable(auth, agentId, tableId, input) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    try {
      await client.query('UPDATE agent_live_data_tables SET name=$4, updated_by=$5 WHERE tenant_id=$1 AND agent_id=$2 AND id=$3',
        [auth.tenantId, agentId, tableId, input.name, auth.userId]);
      await audit(client, auth, 'AGENT_LIVE_DATA_TABLE_UPDATED', tableId, { name: input.name });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'A Live Data table with this name already exists for the agent', 'LIVE_DATA_TABLE_EXISTS');
      throw error;
    }
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function deleteLiveDataTable(auth, agentId, tableId) {
  const result = await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    await client.query('DELETE FROM agent_live_data_tables WHERE tenant_id=$1 AND agent_id=$2 AND id=$3', [auth.tenantId, agentId, tableId]);
    await audit(client, auth, 'AGENT_LIVE_DATA_TABLE_DELETED', tableId, { agentId });
    return { id: tableId, deleted: true };
  });
  try { await deleteAgentLiveDataTableIndex(auth, agentId, tableId); } catch { /* PostgreSQL deletion remains authoritative; a later repair can remove a stale index. */ }
  return result;
}

export async function createLiveDataColumn(auth, agentId, tableId, input) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    let key = keyFromName(input.name);
    const existing = await columnsForTable(client, auth.tenantId, tableId);
    const keys = new Set(existing.map((column) => column.column_key));
    let suffix = 2;
    while (keys.has(key)) key = `${keyFromName(input.name).slice(0, 150)}_${suffix++}`;
    const result = await client.query(
      `INSERT INTO agent_live_data_columns (tenant_id, table_id, name, column_key, data_type, position)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [auth.tenantId, tableId, input.name, key, input.dataType, existing.length],
    );
    await audit(client, auth, 'AGENT_LIVE_DATA_COLUMN_CREATED', result.rows[0].id, { tableId, key, name: input.name });
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function updateLiveDataColumn(auth, agentId, tableId, columnId, input) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    const result = await client.query(
      `UPDATE agent_live_data_columns SET name=COALESCE($4,name), data_type=COALESCE($5,data_type)
       WHERE tenant_id=$1 AND table_id=$2 AND id=$3 RETURNING id`,
      [auth.tenantId, tableId, columnId, input.name ?? null, input.dataType ?? null],
    );
    if (!result.rowCount) throw new AppError(404, 'Live Data column was not found', 'LIVE_DATA_COLUMN_NOT_FOUND');
    await audit(client, auth, 'AGENT_LIVE_DATA_COLUMN_UPDATED', columnId, { tableId });
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function deleteLiveDataColumn(auth, agentId, tableId, columnId) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    const result = await client.query(
      'DELETE FROM agent_live_data_columns WHERE tenant_id=$1 AND table_id=$2 AND id=$3 RETURNING column_key',
      [auth.tenantId, tableId, columnId],
    );
    if (!result.rowCount) throw new AppError(404, 'Live Data column was not found', 'LIVE_DATA_COLUMN_NOT_FOUND');
    await client.query('UPDATE agent_live_data_rows SET row_values=row_values-$3 WHERE tenant_id=$1 AND table_id=$2',
      [auth.tenantId, tableId, result.rows[0].column_key]);
    await audit(client, auth, 'AGENT_LIVE_DATA_COLUMN_DELETED', columnId, { tableId });
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function createLiveDataRow(auth, agentId, tableId, input) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    const values = normalizedValues(input.values, await columnsForTable(client, auth.tenantId, tableId));
    const result = await client.query(
      `INSERT INTO agent_live_data_rows (tenant_id, table_id, row_values, created_by, updated_by)
       VALUES ($1,$2,$3::jsonb,$4,$4) RETURNING id`,
      [auth.tenantId, tableId, JSON.stringify(values), auth.userId],
    );
    await audit(client, auth, 'AGENT_LIVE_DATA_ROW_CREATED', result.rows[0].id, { tableId });
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function updateLiveDataRow(auth, agentId, tableId, rowId, input) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    const values = normalizedValues(input.values, await columnsForTable(client, auth.tenantId, tableId));
    const result = await client.query(
      `UPDATE agent_live_data_rows SET row_values=$4::jsonb, updated_by=$5
       WHERE tenant_id=$1 AND table_id=$2 AND id=$3 RETURNING id`,
      [auth.tenantId, tableId, rowId, JSON.stringify(values), auth.userId],
    );
    if (!result.rowCount) throw new AppError(404, 'Live Data row was not found', 'LIVE_DATA_ROW_NOT_FOUND');
    await audit(client, auth, 'AGENT_LIVE_DATA_ROW_UPDATED', rowId, { tableId });
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}

export async function deleteLiveDataRow(auth, agentId, tableId, rowId) {
  await withTenantContext(auth, async (client) => {
    await requireTable(client, auth.tenantId, agentId, tableId);
    const result = await client.query('DELETE FROM agent_live_data_rows WHERE tenant_id=$1 AND table_id=$2 AND id=$3 RETURNING id',
      [auth.tenantId, tableId, rowId]);
    if (!result.rowCount) throw new AppError(404, 'Live Data row was not found', 'LIVE_DATA_ROW_NOT_FOUND');
    await audit(client, auth, 'AGENT_LIVE_DATA_ROW_DELETED', rowId, { tableId });
  });
  return synchronizeAfterChange(auth, agentId, tableId);
}
