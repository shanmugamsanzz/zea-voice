import assert from 'node:assert/strict';
import { syncAgentLiveDataTable } from '../src/agents/agent-live-data-index.service.js';
import { replaceLiveDataGridSchema } from '../src/agents/agent-live-data.schemas.js';
import { replaceLiveDataGrid } from '../src/agents/agent-live-data.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const tableId = '33333333-3333-4333-8333-333333333333';
const auth = { tenantId };
async function run(count, failure = '') {
  const events = []; const batches = []; let written = [];
  const promise = syncAgentLiveDataTable(auth, agentId, tableId, {
    snapshot: async () => ({ table: { name: 'Catalogue' },
      columns: [{ name: 'Name', column_key: 'name' }],
      rows: Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, row_values: { name: `Item ${i}` }, updated_at: new Date(0) })) }),
    embedTexts: async (texts, options) => {
      assert.equal(options.kind, 'passage');
      assert.ok(texts.length <= 32);
      events.push('embed'); batches.push(texts.length);
      if (batches.length === 2 && failure === 'throw') throw new Error('provider unavailable');
      if (batches.length === 2 && failure === 'count') return [];
      if (batches.length === 2 && failure === 'vector') return texts.map(() => [NaN]);
      return texts.map((text) => {
        const i = Number(text.match(/Item (\d+)/)[1]);
        return Array(768).fill(i);
      });
    },
    ensureTenantCollection: async () => { events.push('ensure'); },
    deleteTablePoints: async (...args) => {
      assert.deepEqual(args, [tenantId, agentId, tableId]); events.push('delete');
    },
    upsertTenantPoints: async (_tenant, points) => { events.push('upsert'); written = points; },
  });
  if (failure) {
    await assert.rejects(promise);
    assert.deepEqual(events, ['embed', 'embed'], 'failed batches must never delete or write the index');
    return;
  }
  assert.deepEqual(await promise, { status: 'synced', indexedRows: count });
  assert.equal(written.length, count);
  written.forEach((point, i) => {
    assert.equal(point.vector[0], i, 'row/vector order must be preserved');
    assert.equal(point.payload.live_data_row_id, `row-${i}`);
    assert.equal(point.payload.tenant_id, tenantId);
    assert.equal(point.payload.agent_id, agentId);
  });
  assert.equal(new Set(written.map((point) => point.id)).size, count);
  if (count) assert.deepEqual(events.slice(-3), ['ensure', 'delete', 'upsert']);
  else assert.deepEqual(events, ['ensure', 'delete']);
  return batches;
}
assert.deepEqual(await run(32), [32]);
assert.deepEqual(await run(42), [32, 10]);
assert.deepEqual(await run(50), [32, 18]);
// Legacy larger tables remain indexable; no existing rows are truncated.
assert.deepEqual(await run(100), [32, 32, 32, 4]);
await run(0);
for (const failure of ['throw', 'count', 'vector']) await run(50, failure);
const grid = (count) => ({ columns: [{ name: 'Name', dataType: 'text' }], rows: Array.from({ length: count }, () => ['Item']) });
assert.equal(replaceLiveDataGridSchema.safeParse(grid(50)).success, true);
assert.equal(replaceLiveDataGridSchema.safeParse(grid(51)).success, false);
// Service-level guard rejects before any database transaction, even bypassing schemas.
await assert.rejects(replaceLiveDataGrid(auth, agentId, tableId, grid(51)), (error) => error.code === 'LIVE_DATA_ROW_LIMIT');
console.log(JSON.stringify({ suite: 'agent-live-data-index', passed: true, cases: 11 }));
