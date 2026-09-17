import { withTenantContext } from '../infrastructure/database-context.js';
import { requireEntityId, requireTenantId } from '../rag/tenant-isolation.js';

const MAXIMUM_TABLES = 2;
const MAXIMUM_ROWS_PER_TABLE = 500;

/**
 * Qdrant chooses relevant table IDs semantically. PostgreSQL then supplies the
 * current schema and rows, so prices, counts and statuses never come from a
 * stale vector payload.
 */
export async function retrieveCurrentAgentLiveData(tenantId, agentId, tableIds = []) {
  const resolvedTenantId = requireTenantId(tenantId);
  const resolvedAgentId = requireEntityId(agentId, 'agentId');
  const ids = [...new Set((Array.isArray(tableIds) ? tableIds : [])
    .map((id) => requireEntityId(id, 'liveDataTableId')))].slice(0, MAXIMUM_TABLES);
  if (!ids.length) return Object.freeze([]);
  return withTenantContext({ tenantId: resolvedTenantId, userId: '', role: 'SYSTEM' }, async (client) => {
    const tables = await client.query(
      `SELECT id, name FROM agent_live_data_tables
       WHERE tenant_id=$1 AND agent_id=$2 AND id = ANY($3::uuid[])
       ORDER BY array_position($3::uuid[], id)`,
      [resolvedTenantId, resolvedAgentId, ids],
    );
    const result = [];
    for (const table of tables.rows) {
      const [columns, rows, count] = await Promise.all([
        client.query(
          `SELECT name, column_key, data_type FROM agent_live_data_columns
           WHERE tenant_id=$1 AND table_id=$2 ORDER BY position, created_at`,
          [resolvedTenantId, table.id],
        ),
        client.query(
          `SELECT id, row_values, updated_at FROM agent_live_data_rows
           WHERE tenant_id=$1 AND table_id=$2 ORDER BY created_at LIMIT $3`,
          [resolvedTenantId, table.id, MAXIMUM_ROWS_PER_TABLE],
        ),
        client.query(
          'SELECT count(*)::integer AS count FROM agent_live_data_rows WHERE tenant_id=$1 AND table_id=$2',
          [resolvedTenantId, table.id],
        ),
      ]);
      result.push(Object.freeze({
        id: table.id, name: table.name, rowCount: count.rows[0].count,
        truncated: count.rows[0].count > rows.rowCount,
        columns: Object.freeze(columns.rows.map((column) => Object.freeze({
          name: column.name, key: column.column_key, type: column.data_type,
        }))),
        rows: Object.freeze(rows.rows.map((row) => Object.freeze({
          id: row.id, values: row.row_values, updatedAt: row.updated_at,
        }))),
      }));
    }
    return Object.freeze(result);
  });
}
