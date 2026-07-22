import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';

process.env.N8N_API_KEY = 'n8n-verification-key-32-characters';
process.env.LOG_LEVEL = 'silent';
process.env.PUBLIC_BASE_URL = 'https://api.example.test';
process.env.PLIVO_ANSWER_URL = 'https://voice.example.test/answer';
process.env.CREDENTIAL_ENCRYPTION_KEY ||= Buffer.alloc(32, 21).toString('base64');

const { requireN8nApiKey } = await import('../src/integrations/n8n/n8n.auth.js');
const { n8nTriggerCallSchema } = await import('../src/integrations/n8n/n8n.schemas.js');
const { triggerN8nCall } = await import('../src/integrations/n8n/n8n.service.js');
const { encryptCredential } = await import('../src/security/credential-crypto.js');
const { createApp } = await import('../src/app.js');

const ids = {
  organization: crypto.randomUUID(), workspace: crypto.randomUUID(), agent: crypto.randomUUID(),
  campaign: crypto.randomUUID(), tenant: crypto.randomUUID(), phone: crypto.randomUUID(),
  account: crypto.randomUUID(), call: crypto.randomUUID(), providerCall: crypto.randomUUID(),
};
const input = {
  organization_id: ids.organization,
  workspace_id: ids.workspace,
  agent_id: ids.agent,
  campaign_id: ids.campaign,
  customer_number: '+919876543210',
};
const assigned = {
  tenant_id: ids.tenant,
  tenant_status: 'active', organization_status: 'active', workspace_status: 'active',
  agent_id: ids.agent, agent_name: 'Verification Agent', agent_status: 'active', usage_direction: 'outbound',
  campaign_id: ids.campaign, campaign_name: 'Verification Campaign', campaign_status: 'running',
  phone_number_id: ids.phone, from_number: '+918035383450', phone_status: 'active',
  assigned_tenant_id: ids.tenant, assignment_tenant_id: ids.tenant,
  telephony_account_id: ids.account, provider: 'plivo', account_status: 'connected',
  auth_id: 'verification-auth-id', auth_token_encrypted: encryptCredential('verification-auth-token'),
  base_url: 'https://api.plivo.test/v1',
};

function dependencies(selected = assigned, options = {}) {
  const queries = [];
  const client = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes('FROM organizations o')) {
      const sameResources = values[0] === input.organization_id && values[1] === input.workspace_id
        && values[2] === input.agent_id && values[3] === input.campaign_id;
      return { rowCount: sameResources && selected ? 1 : 0, rows: sameResources && selected ? [selected] : [] };
    }
    if (sql.includes('INSERT INTO call_sessions')) return { rowCount: 1, rows: [{ id: ids.call, status: 'queued' }] };
    if (sql.includes("status='ringing'")) return { rowCount: 1, rows: [{ status: 'ringing' }] };
    if (sql.includes("status='failed'")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected verification query: ${sql}`);
  } };
  const providerInputs = [];
  return {
    queries, providerInputs,
    value: {
      contextRunner: async (_userId, operation) => operation(client),
      makeCall: options.makeCall ?? (async (authId, token, callInput, _fetch, baseUrl) => {
        providerInputs.push({ authId, token, callInput, baseUrl });
        return { requestUuid: ids.providerCall, message: 'call fired' };
      }),
    },
  };
}

assert.equal(n8nTriggerCallSchema.safeParse(input).success, true);
assert.equal(n8nTriggerCallSchema.safeParse({ ...input, customer_number: '9876543210' }).success, false);
assert.equal(n8nTriggerCallSchema.safeParse({ ...input, phone_number_id: ids.phone }).success, false);

let authError;
requireN8nApiKey({ get: () => 'wrong-key' }, {}, (error) => { authError = error; });
assert.equal(authError?.code, 'N8N_API_KEY_INVALID');
let authenticated = false;
requireN8nApiKey({ get: () => process.env.N8N_API_KEY }, {}, (error) => {
  assert.equal(error, undefined); authenticated = true;
});
assert.equal(authenticated, true);

const server = createServer(createApp());
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const endpoint = `http://127.0.0.1:${server.address().port}/integrations/n8n/trigger-call`;
  const unauthorized = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-n8n-api-key': 'wrong-key' },
    body: JSON.stringify(input),
  });
  assert.equal(unauthorized.status, 401);
  const invalid = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-n8n-api-key': process.env.N8N_API_KEY },
    body: JSON.stringify({ ...input, customer_number: '9876543210' }),
  });
  assert.equal(invalid.status, 400);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const valid = dependencies();
assert.deepEqual(await triggerN8nCall(input, valid.value), {
  call_session_id: ids.call, status: 'ringing',
});
assert.equal(valid.providerInputs.length, 1);
assert.deepEqual(valid.providerInputs[0], {
  authId: assigned.auth_id,
  token: 'verification-auth-token',
  callInput: {
    from: assigned.from_number,
    to: input.customer_number,
    answerUrl: `${process.env.PLIVO_ANSWER_URL}?call_session_id=${ids.call}`,
  },
  baseUrl: assigned.base_url,
});
const insert = valid.queries.find(({ sql }) => sql.includes('INSERT INTO call_sessions'));
assert.equal(insert.values[0], ids.tenant);
assert.equal(insert.values[1], ids.workspace);
assert.equal(insert.values[3], ids.phone);
assert.equal(insert.values[6], ids.campaign);
assert.equal(insert.values[9], input.customer_number);

const isolated = dependencies();
await assert.rejects(
  triggerN8nCall({ ...input, workspace_id: crypto.randomUUID() }, isolated.value),
  (error) => error.code === 'N8N_CALL_RESOURCES_NOT_FOUND',
);
assert.equal(isolated.providerInputs.length, 0);

const unassigned = dependencies({ ...assigned, assignment_tenant_id: null });
await assert.rejects(triggerN8nCall(input, unassigned.value),
  (error) => error.code === 'N8N_PHONE_NOT_ASSIGNED');
assert.equal(unassigned.providerInputs.length, 0);

const providerFailure = dependencies(assigned, {
  makeCall: async () => { throw new Error('provider unavailable'); },
});
await assert.rejects(triggerN8nCall(input, providerFailure.value), /provider unavailable/);
assert.equal(providerFailure.queries.some(({ sql }) => sql.includes("status='failed'")), true);

console.log(JSON.stringify({
  success: true,
  apiKeySecurity: 'passed',
  strictRequestValidation: 'passed',
  tenantWorkspaceIsolation: 'passed',
  assignedPhoneSelection: 'passed',
  plivoCallAndSessionLifecycle: 'passed',
}, null, 2));
