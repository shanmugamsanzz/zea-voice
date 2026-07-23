import assert from 'node:assert/strict';
import { createPublicTask } from '../src/public-tasks/public-task.service.js';

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  agent: '44444444-4444-4444-8444-444444444444',
  campaign: '55555555-5555-4555-8555-555555555555',
};
const auth = {
  authType: 'api_key', apiKeyId: '66666666-6666-4666-8666-666666666666',
  userId: '77777777-7777-4777-8777-777777777777', role: 'COMPANY_DEVELOPER',
  tenantId: ids.tenant, workspaceId: ids.workspace, scopes: ['calls:create'],
};
const campaign = {
  id: ids.campaign, tenant_id: ids.tenant, workspace_id: ids.workspace,
  organization_id: ids.organization, agent_id: ids.agent, from_number: '+918035088313',
  retries: 3, retry_intervals_ms: ['300000', '600000', '900000'],
};
const input = {
  agent: ids.agent, campaign: ids.campaign, phone: '+919489974421', from: '+918035088313',
  workspace_id: ids.workspace, tenant_id: ids.tenant, organization_id: ids.organization,
  retries: 3, intervals: [300000, 600000, 900000], context: { lead_name: 'Zea', company: 'Example' },
};

function dependencies(taskFactory) {
  return {
    contextRunner: async (_auth, operation) => operation({
      query: async () => ({ rowCount: 1, rows: [campaign] }),
    }),
    createTask: taskFactory,
  };
}

let received;
const created = await createPublicTask(auth, 'execution-100', input, dependencies(async (...args) => {
  received = args;
  return {
    created: true,
    task: { id: 'task-1', phone: input.phone, context: input.context },
  };
}));
assert.equal(created.created, true);
assert.equal(received[1], ids.campaign);
assert.equal(received[2].name, 'Zea');
assert.match(received[2].eventId, /^public:[a-f0-9]{64}$/);

const duplicate = await createPublicTask(auth, 'execution-100', input, dependencies(async (...args) => ({
  created: false,
  task: { id: 'task-1', phone: input.phone, context: input.context, eventId: args[2].eventId },
})));
assert.equal(duplicate.created, false);

async function expectCode(changes, code, customAuth = auth) {
  await assert.rejects(
    createPublicTask(customAuth, 'execution-200', { ...input, ...changes }, dependencies(async () => ({
      created: true, task: {},
    }))),
    (error) => error.code === code,
  );
}

await expectCode({ workspace_id: '88888888-8888-4888-8888-888888888888' }, 'PUBLIC_TASK_WORKSPACE_ACCESS_DENIED');
await expectCode({ tenant_id: '88888888-8888-4888-8888-888888888888' }, 'PUBLIC_TASK_TENANT_ACCESS_DENIED');
await expectCode({ organization_id: '88888888-8888-4888-8888-888888888888' }, 'PUBLIC_TASK_ORGANIZATION_ACCESS_DENIED');
await expectCode({ agent: '88888888-8888-4888-8888-888888888888' }, 'PUBLIC_TASK_AGENT_MISMATCH');
await expectCode({ from: '+918000000000' }, 'PUBLIC_TASK_FROM_MISMATCH');
await expectCode({ retries: 1, intervals: [300000] }, 'PUBLIC_TASK_RETRY_POLICY_MISMATCH');
await expectCode({}, 'COMPANY_API_KEY_REQUIRED', { ...auth, authType: 'access_token', apiKeyId: null });

await assert.rejects(createPublicTask(auth, 'execution-300', input, dependencies(async () => ({
  created: false,
  task: { id: 'task-2', phone: '+919000000000', context: input.context },
}))), (error) => error.code === 'IDEMPOTENCY_KEY_REUSED');

console.log(JSON.stringify({
  success: true,
  publicTaskCreation: 'passed',
  tenantWorkspaceOrganizationIsolation: 'passed',
  campaignResourceAssertions: 'passed',
  apiKeyOnlyAuthentication: 'passed',
  idempotency: 'passed',
}, null, 2));
