import assert from 'node:assert/strict';
import { retrieveAgentQdrantKnowledge } from '../src/voice/interaction/agent-qdrant-retrieval.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const tableId = '33333333-3333-4333-8333-333333333333';
const rowId = '44444444-4444-4444-8444-444444444444';
let embeds = 0;
let searches = 0;
let requestedTableIds = [];

const result = await retrieveAgentQdrantKnowledge({
  tenantId, agentId, question: 'What is currently available?', previousContext: [],
  cancellationSignal: new AbortController().signal,
}, {
  embedQuestion: async () => {
    embeds += 1;
    return { model: 'intfloat/multilingual-e5-base', vector: Array.from({ length: 768 }, () => 0.01) };
  },
  searchPoints: async () => {
    searches += 1;
    return [
      { id: 'live-point', score: 0.92, payload: { tenant_id: tenantId, agent_id: agentId,
        source_kind: 'agent_live_data_row', live_data_table_id: tableId, live_data_row_id: rowId } },
      { id: 'wrong-tenant', score: 0.99, payload: { tenant_id: '55555555-5555-4555-8555-555555555555', agent_id: agentId,
        source_kind: 'agent_live_data_row', live_data_table_id: tableId, live_data_row_id: rowId } },
    ];
  },
  retrieveLiveData: async (_tenant, _agent, tableIds) => {
    requestedTableIds = tableIds;
    return [{ id: tableId, name: 'Properties', rowCount: 1, truncated: false,
      columns: [{ name: 'Status', key: 'status', type: 'text' }], rows: [{ id: rowId, values: { status: 'Available' } }] }];
  },
});

assert.equal(embeds, 1);
assert.equal(searches, 1);
assert.deepEqual(requestedTableIds, [tableId]);
assert.equal(result.liveData[0].rows[0].values.status, 'Available');
assert.equal(result.diagnostics.qdrantSearchCount, 1);
assert.equal(result.diagnostics.tenantAgentFiltered, true);
console.log(JSON.stringify({ suite: 'agent-live-data-retrieval', passed: true, embeds, searches }));
