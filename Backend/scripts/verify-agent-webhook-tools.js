import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { encryptCredential } = await import('../src/security/credential-crypto.js');
const { testAgentTool } = await import('../src/agents/agent-tool-test.service.js');
const { validateWebhookEndpoint } = await import('../src/voice/tools/tool-security.js');

for (const endpoint of ['http://127.0.0.1/tool', 'http://localhost/tool', 'http://169.254.169.254/latest/meta-data']) {
  await assert.rejects(validateWebhookEndpoint(endpoint), (error) => error.code === 'VOICE_TOOL_PRIVATE_ENDPOINT');
}

let queryValues;
let request;
const result = await testAgentTool({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'developer-a',
}, 'agent-a', 'tool-a', { arguments: { date: '2026-07-27' } }, {
  contextRunner: async (_auth, operation) => operation({
    async query(_sql, values) {
      queryValues = values;
      return { rowCount: 1, rows: [{
        id: 'tool-a', agent_id: 'agent-a', name: 'check_slots', type: 'webhook_api',
        description: 'Check available appointment slots', status: 'active',
        configuration: {
          url: 'https://tools.example.test/slots', method: 'POST', timeoutMs: 8000,
          headers: { 'x-public': 'yes' },
          inputSchema: { type: 'object', required: ['date'], properties: { date: { type: 'string' } }, additionalProperties: false },
        },
        secret_configuration_encrypted: encryptCredential(JSON.stringify({ headers: { authorization: 'Bearer encrypted-secret' } })),
      }] };
    },
  }),
  fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ success: true, available: ['10:00', '11:30'] }), { status: 200 });
  },
});

assert.deepEqual(queryValues, ['tenant-a', 'workspace-a', 'agent-a', 'tool-a']);
assert.equal(request.url, 'https://tools.example.test/slots');
assert.equal(request.options.headers.authorization, 'Bearer encrypted-secret');
assert.equal(request.options.redirect, 'error');
assert.equal(JSON.parse(request.options.body).arguments.date, '2026-07-27');
assert.equal(result.success, true);
assert.deepEqual(result.output, { success: true, available: ['10:00', '11:30'] });

console.log(JSON.stringify({ success: true, tenantIsolation: 'verified', encryptedHeaders: 'verified', runtimeExecution: 'verified' }));
