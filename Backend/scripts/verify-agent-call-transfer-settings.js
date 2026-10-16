import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
const { callTransferSettingsSchema } = await import('../src/agents/agent-call-transfer.schemas.js');
const { getCallTransferSettings, saveCallTransferSettings, deleteCallTransferSettings } =
  await import('../src/agents/agent-call-transfer.service.js');
const { decryptCredential } = await import('../src/security/credential-crypto.js');

const auth = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: null };
const agentId = 'agent-a';
const accountId = '11111111-1111-4111-8111-111111111111';
const otherAccountId = '22222222-2222-4222-8222-222222222222';
const callbackToolId = '33333333-3333-4333-8333-333333333333';
const account = { id: accountId, name: 'Company A', auth_id: 'SATESTACCOUNT12345678' };
const saved = { enabled: false, credentialSource: 'saved_account', telephonyAccountId: accountId,
  destinationNumber: '+919876543210', mode: 'wait_and_return', ringTimeoutSeconds: 25 };
for (const patch of [ { destinationNumber: '123' }, { destinationNumber: 'https://example.com' },
  { ringTimeoutSeconds: 9 }, { ringTimeoutSeconds: 121 }, { ringTimeoutSeconds: 10.5 },
  { mode: 'unknown' }, { authToken: 'secret-value-not-allowed' }, { credentialSource: 'manual', authId: 'MAINACCOUNT' },
  { callerDestination: '+919999999999' } ]) assert.equal(callTransferSettingsSchema.safeParse({ ...saved, ...patch }).success, false);
assert.equal(callTransferSettingsSchema.safeParse(saved).success, true);
let row = null;
let agentExists = true;
let accountReads = 0;
const queries = [];
const dependencies = {
  contextRunner: async (scope, operation) => {
    assert.deepEqual(scope, auth);
    return operation({ query: async (sql, values) => {
      queries.push(sql);
      if (sql.includes('FROM voice_agents')) {
        assert.deepEqual(values, [auth.tenantId, auth.workspaceId, agentId]);
        return { rowCount: agentExists ? 1 : 0, rows: agentExists ? [{ id: agentId }] : [] };
      }
      if (sql.includes('SELECT * FROM agent_call_transfer_settings')) {
        assert.deepEqual(values, [auth.tenantId, auth.workspaceId, agentId]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('FROM agent_tools')) {
        assert.deepEqual(values, [auth.tenantId, auth.workspaceId, agentId]);
        assert.match(sql, /status='active'/); assert.match(sql, /type='webhook_api'/);
        return { rows: [{ id: callbackToolId, name: 'Staff callback' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO agent_call_transfer_settings')) {
        assert.deepEqual(values.slice(0, 3), [agentId, auth.tenantId, auth.workspaceId]);
        row = { enabled: values[3], credential_source: values[4], telephony_account_id: values[5],
          auth_id: values[6], auth_token_encrypted: values[7], destination_number: values[8],
          transfer_mode: values[9], ring_timeout_seconds: values[10], callback_tool_id: values[12] };
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes('DELETE FROM agent_call_transfer_settings')) {
        assert.deepEqual(values, [auth.tenantId, auth.workspaceId, agentId]);
        row = null; return { rowCount: 1, rows: [] };
      }
      throw Error('Unexpected query');
    } });
  },
  accountContextRunner: async (_actor, operation) => operation({ query: async (sql, values) => {
    accountReads += 1;
    assert.deepEqual(values, [auth.tenantId]);
    assert.match(sql, /tenant_id=\$1/);
    assert.match(sql, /account_type='subaccount'/);
    assert.match(sql, /status='connected'/);
    assert.ok(!sql.includes('auth_token'));
    return { rows: [account] };
  } }),
};
assert.equal((await getCallTransferSettings(auth, agentId, dependencies)).settings, null);
const result = await saveCallTransferSettings(auth, agentId, saved, dependencies);
assert.equal(result.runtimeAvailable, false);
assert.equal(result.settings.destinationNumber, saved.destinationNumber);
assert.equal(row.auth_token_encrypted, null);
await assert.rejects(saveCallTransferSettings(auth, agentId, { ...saved, callbackToolId: otherAccountId }, dependencies),
  error => error.code === 'TRANSFER_CALLBACK_TOOL_NOT_ALLOWED');
const configured = await saveCallTransferSettings(auth, agentId, { ...saved, callbackToolId }, dependencies);
assert.equal(configured.settings.callbackToolId, callbackToolId);
await saveCallTransferSettings(auth, agentId, saved, dependencies);
assert.equal(row.callback_tool_id, callbackToolId, 'Older clients preserve an omitted callback selection');
await assert.rejects(saveCallTransferSettings(auth, agentId, { ...saved, telephonyAccountId: otherAccountId }, dependencies),
  (error) => error.code === 'TRANSFER_ACCOUNT_NOT_ALLOWED');
const manual = { ...saved, credentialSource: 'manual', telephonyAccountId: null,
  authId: account.auth_id, authToken: 'test-private-plivo-token-1234' };
const manualResult = await saveCallTransferSettings(auth, agentId, manual, dependencies);
assert.ok(row.auth_token_encrypted.startsWith('v1.'));
assert.equal(decryptCredential(row.auth_token_encrypted), manual.authToken);
assert.equal(manualResult.settings.hasAuthToken, true);
assert.ok(!JSON.stringify(manualResult).includes(manual.authToken));
assert.ok(!JSON.stringify(manualResult).includes('auth_token_encrypted'));
const encrypted = row.auth_token_encrypted;
const { authToken: _removed, ...unchangedManual } = manual;
await saveCallTransferSettings(auth, agentId, unchangedManual, dependencies);
assert.equal(row.auth_token_encrypted, encrypted, 'Blank token retains matching account secret');
await assert.rejects(saveCallTransferSettings(auth, agentId, { ...manual, authId: 'SAOTHERCOMPANY12345' }, dependencies),
  (error) => error.code === 'TRANSFER_ACCOUNT_NOT_ALLOWED');
const dto = await getCallTransferSettings(auth, agentId, dependencies);
assert.ok(!JSON.stringify(dto).includes(encrypted));
await saveCallTransferSettings(auth, agentId, saved, dependencies);
assert.equal(row.auth_token_encrypted, null, 'Switching to saved account clears manual token');
await assert.rejects(saveCallTransferSettings(auth, agentId, unchangedManual, dependencies),
  (error) => error.code === 'TRANSFER_TOKEN_REQUIRED');
await deleteCallTransferSettings(auth, agentId, dependencies);
assert.equal(row, null);
const priorReads = accountReads;
agentExists = false;
await assert.rejects(getCallTransferSettings(auth, agentId, dependencies), (error) => error.code === 'AGENT_NOT_FOUND');
await assert.rejects(saveCallTransferSettings(auth, agentId, saved, dependencies), (error) => error.code === 'AGENT_NOT_FOUND');
assert.equal(accountReads, priorReads, 'Wrong-workspace agents cannot read accounts');
assert.ok(queries.some((sql) => sql.includes('FOR UPDATE')));
const runtime = await readFile(new URL('../src/voice/providers/provider-config.js', import.meta.url), 'utf8');
assert.ok(!runtime.includes('agent_call_transfer_settings'), 'Settings must not activate execution in Task 1');
const migration = await import('../migrations/1792100000000_agent-call-transfer-settings.js');
let migrationSql = '';
await migration.up({ sql: (sql) => { migrationSql += sql; } });
assert.match(migrationSql, /FORCE ROW LEVEL SECURITY/);
assert.match(migrationSql, /WITH CHECK/);
assert.match(migrationSql, /auth_token_encrypted text/);
assert.ok(!migrationSql.includes('ALTER TABLE agent_tools'));
console.log('Transfer settings passed: schema validation, tenant/workspace isolation, account scoping, real encryption, token preservation/clearing, secret-free DTO, reset and runtime separation. DB behavior uses mocked transactions; migration not run against a live DB.');
