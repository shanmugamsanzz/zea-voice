import { createHash } from 'node:crypto';
import { embedTexts } from '../rag/embedding.client.js';
import {
  deleteTenantAgentLiveDataTablePoints,
  ensureTenantCollection,
  upsertTenantPoints,
} from '../rag/qdrant.client.js';
import { requireEntityId, requireTenantId } from '../rag/tenant-isolation.js';
import { withTenantContext } from '../infrastructure/database-context.js';

function pointUuid(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function rowText(tableName, columns, rowValues) {
  const values = columns.map((column) => `${column.name}: ${String(rowValues?.[column.column_key] ?? '')}`);
  return [`Live Data table: ${tableName}`, ...values].join('\n');
}

async function snapshot(auth, agentId, tableId) {
  return withTenantContext(auth, async (client) => {
    const table = await client.query(
      `SELECT id, name FROM agent_live_data_tables
       WHERE tenant_id=$1 AND agent_id=$2 AND id=$3`,
      [auth.tenantId, agentId, tableId],
    );
    if (!table.rowCount) return null;
    const columns = await client.query(
      `SELECT name, column_key, data_type FROM agent_live_data_columns
       WHERE tenant_id=$1 AND table_id=$2 ORDER BY position, created_at`,
      [auth.tenantId, tableId],
    );
    const rows = await client.query(
      `SELECT id, row_values, updated_at FROM agent_live_data_rows
       WHERE tenant_id=$1 AND table_id=$2 ORDER BY created_at`,
      [auth.tenantId, tableId],
    );
    return { table: table.rows[0], columns: columns.rows, rows: rows.rows };
  });
}

function verifiedVector(vector) {
  if (!Array.isArray(vector) || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Live Data embedding provider returned an invalid vector');
  }
  return vector;
}

/** Replaces Qdrant points for exactly one agent table from its committed PostgreSQL snapshot. */
export async function syncAgentLiveDataTable(auth, agentId, tableId) {
  const tenantId = requireTenantId(auth?.tenantId);
  const resolvedAgentId = requireEntityId(agentId, 'agentId');
  const resolvedTableId = requireEntityId(tableId, 'tableId');
  const data = await snapshot(auth, resolvedAgentId, resolvedTableId);
  await ensureTenantCollection(tenantId);
  await deleteTenantAgentLiveDataTablePoints(tenantId, resolvedAgentId, resolvedTableId);
  if (!data?.rows.length || !data.columns.length) return { status: 'synced', indexedRows: 0 };

  const texts = data.rows.map((row) => rowText(data.table.name, data.columns, row.row_values));
  const vectors = await embedTexts(texts, { kind: 'passage' });
  if (!Array.isArray(vectors) || vectors.length !== data.rows.length) {
    throw new Error('Live Data embedding provider returned an unexpected vector count');
  }
  const now = new Date().toISOString();
  const points = data.rows.map((row, index) => ({
    id: pointUuid(`${tenantId}:${resolvedAgentId}:${resolvedTableId}:${row.id}:${row.updated_at.toISOString()}`),
    vector: verifiedVector(vectors[index]),
    payload: {
      tenant_id: tenantId,
      agent_id: resolvedAgentId,
      source_kind: 'agent_live_data_row',
      live_data_table_id: resolvedTableId,
      live_data_row_id: row.id,
      live_data_table_name: data.table.name,
      live_data_text: texts[index],
      updated_at: row.updated_at.toISOString(),
      uploaded_at: now,
    },
  }));
  await upsertTenantPoints(tenantId, points);
  return { status: 'synced', indexedRows: points.length };
}

export async function deleteAgentLiveDataTableIndex(auth, agentId, tableId) {
  await deleteTenantAgentLiveDataTablePoints(
    requireTenantId(auth?.tenantId), requireEntityId(agentId, 'agentId'), requireEntityId(tableId, 'tableId'),
  );
  return { status: 'synced', indexedRows: 0 };
}
