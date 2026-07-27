import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pronunciationRouter } from '../src/pronunciations/pronunciation.routes.js';
import { replaceAgentPronunciationGroups } from '../src/pronunciations/pronunciation.service.js';

const routes = pronunciationRouter.stack
  .filter((layer) => layer.route)
  .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
assert.deepEqual(routes, [
  'GET /',
  'POST /',
  'GET /:groupId',
  'PATCH /:groupId',
  'DELETE /:groupId',
  'POST /:groupId/rules',
  'PATCH /:groupId/rules/:ruleId',
  'DELETE /:groupId/rules/:ruleId',
]);
assert.equal(pronunciationRouter.stack[0].name, 'authenticateRequest');
assert.equal(pronunciationRouter.stack[1].name, 'requireTenantContext');

const tenantId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';
const groupId = '55555555-5555-4555-8555-555555555555';
const auth = { tenantId, workspaceId, userId, role: 'COMPANY_DEVELOPER', authType: 'session' };

const attemptedQueries = [];
const unavailableClient = {
  async query(text, values) {
    attemptedQueries.push({ text, values });
    if (text.includes('SELECT id FROM voice_agents')) return { rowCount: 1, rows: [{ id: agentId }] };
    if (text.includes('FROM agent_pronunciation_groups apg')) return { rowCount: 0, rows: [] };
    if (text.includes('SELECT id FROM pronunciation_groups')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  },
};
const contextRunner = async (receivedAuth, operation) => {
  assert.equal(receivedAuth.tenantId, tenantId);
  return operation(unavailableClient);
};
await assert.rejects(
  replaceAgentPronunciationGroups(auth, agentId, { groupIds: [groupId] }, contextRunner),
  (error) => error.code === 'AGENT_PRONUNCIATION_GROUP_UNAVAILABLE' && error.statusCode === 409,
);
assert.equal(attemptedQueries.some(({ text }) => text.includes('DELETE FROM agent_pronunciation_groups')), false);
for (const query of attemptedQueries) {
  if (query.values?.length) assert.equal(query.values[0], tenantId);
}

let assignmentReadCount = 0;
const successfulQueries = [];
const successfulClient = {
  async query(text, values) {
    successfulQueries.push({ text, values });
    if (text.includes('SELECT id FROM voice_agents')) return { rowCount: 1, rows: [{ id: agentId }] };
    if (text.includes('FROM agent_pronunciation_groups apg')) {
      assignmentReadCount += 1;
      return assignmentReadCount === 1
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{
          agent_id: agentId, group_id: groupId, group_name: 'Medical Terms', language: 'ta-IN',
          status: 'active', priority: 0, rule_count: 2, assigned_by: userId, created_at: new Date(0),
        }] };
    }
    if (text.includes('SELECT id FROM pronunciation_groups')) return { rowCount: 1, rows: [{ id: groupId }] };
    if (text.includes('DELETE FROM agent_pronunciation_groups')) return { rowCount: 0, rows: [] };
    if (text.includes('INSERT INTO agent_pronunciation_groups')) return { rowCount: 1, rows: [] };
    if (text.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  },
};
const successful = await replaceAgentPronunciationGroups(
  auth,
  agentId,
  { groupIds: [groupId] },
  async (_receivedAuth, operation) => operation(successfulClient),
);
assert.equal(successful.length, 1);
assert.equal(successful[0].groupId, groupId);
assert.equal(successful[0].priority, 0);
const assignmentInsert = successfulQueries.find(({ text }) => text.includes('INSERT INTO agent_pronunciation_groups'));
assert.deepEqual(assignmentInsert.values.slice(0, 3), [tenantId, agentId, [groupId]]);

const groupMigration = await readFile(new URL('../migrations/1785300000000_pronunciation-groups.js', import.meta.url), 'utf8');
const assignmentMigration = await readFile(new URL('../migrations/1785400000000_agent-pronunciation-groups.js', import.meta.url), 'utf8');
for (const source of [groupMigration, assignmentMigration]) {
  assert.match(source, /ENABLE ROW LEVEL SECURITY/);
  assert.match(source, /FORCE ROW LEVEL SECURITY/);
  assert.match(source, /tenant_id = zea_current_tenant_id\(\)/);
}
assert.match(groupMigration, /FOREIGN KEY \(tenant_id, group_id\)/);
assert.match(assignmentMigration, /FOREIGN KEY \(tenant_id, agent_id\)/);
assert.match(assignmentMigration, /FOREIGN KEY \(tenant_id, group_id\)/);

console.log(JSON.stringify({ success: true, task: 'Tenant-secured pronunciation APIs and agent assignments' }));
