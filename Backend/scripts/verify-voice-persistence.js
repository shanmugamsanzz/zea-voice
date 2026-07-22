import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const { executePreCall } = await import('../src/voice/integrations/precall.service.js');
const { reportPostCall } = await import('../src/voice/integrations/postcall.service.js');
const { executeAgentTool } = await import('../src/voice/tools/tool-executor.service.js');
const { saveVoiceCallPreCallResult } = await import('../src/voice/call-session-store.js');

const variable = (name) => '$' + '{' + name + '}';
const runtimeProfile = {
  agent: {
    id: 'agent-1', tenantId: 'tenant-a', workspaceId: 'workspace-a', name: 'Hospital Agent',
  },
  integrations: {
    preCall: {
      prompt: 'Load caller context',
      api: {
        active: true,
        url: 'https://crm.example.test/caller',
        method: 'POST',
        headers: { 'x-company': variable('company_id') },
        requestBody: { caller: variable('caller'), callId: variable('call_uuid') },
        responseMappings: [
          { source: 'customer.name', target: 'customer_name' },
          { source: 'customer.tier', target: 'customer_tier' },
        ],
      },
    },
    postCall: {
      api: {
        active: true,
        url: 'https://crm.example.test/call-completed',
        method: 'POST',
        headers: { 'x-event': 'voice-call' },
      },
    },
  },
  tools: [{
    id: 'tool-1', name: 'book visit', type: 'webhook_api',
    configuration: { url: 'https://tools.example.test/book', method: 'POST', headers: { 'x-public': 'yes' } },
    secretConfiguration: { headers: { authorization: 'Bearer secret' } },
  }],
};
const call = {
  id: 'call-1', providerCallId: 'plivo-1', from: '+919000000001', to: '+918000000001',
  direction: 'inbound', tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-1',
};

let preCallRequest;
const preCall = await executePreCall(runtimeProfile, call, {
  fetchImpl: async (url, request) => {
    preCallRequest = { url, request };
    return new Response(JSON.stringify({
      customer: { name: 'Shanmugam', tier: 'gold' }, internalSecret: 'must-not-enter-llm-context',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(preCall.delivered, true);
assert.deepEqual(preCall.context, { customer_name: 'Shanmugam', customer_tier: 'gold' });
assert.equal(preCall.context.internalSecret, undefined);
assert.equal(preCallRequest.request.headers['x-company'], 'tenant-a');
assert.deepEqual(JSON.parse(preCallRequest.request.body), { caller: call.from, callId: call.providerCallId });
assert.ok(preCall.durationMs >= 0);

let savedMetadata;
const savedCall = await saveVoiceCallPreCallResult(call.id, preCall, {
  contextRunner: async (operation) => operation({
    async query(sql, values) {
      assert.ok(sql.includes("'{preCall}'"));
      savedMetadata = { preCall: JSON.parse(values[1]) };
      return { rowCount: 1, rows: [{
        id: call.id, tenant_id: 'tenant-a', workspace_id: 'workspace-a', provider_call_id: 'plivo-1',
        agent_id: 'agent-1', from_number: call.from, to_number: call.to, direction: 'inbound',
        status: 'connected', provider_metadata: savedMetadata,
      }] };
    },
  }),
});
assert.equal(savedCall.providerMetadata.preCall.context.customer_name, 'Shanmugam');

let toolRequest;
const toolResult = await executeAgentTool(runtimeProfile, call, {
  id: 'tool-call-1', name: 'book_visit', arguments: { date: 'tomorrow' },
}, {
  fetchImpl: async (url, request) => {
    toolRequest = { url, request };
    return new Response(JSON.stringify({ bookingId: 'B-1' }), { status: 200 });
  },
});
assert.equal(toolResult.success, true);
assert.equal(toolRequest.request.headers.authorization, 'Bearer secret');
assert.equal(JSON.parse(toolRequest.request.body).context.tenantId, 'tenant-a');
let unassignedNetworkCalled = false;
await assert.rejects(
  executeAgentTool(runtimeProfile, call, { name: 'delete_everything', arguments: {} }, {
    fetchImpl: async () => { unassignedNetworkCalled = true; },
  }),
  (error) => error.code === 'VOICE_TOOL_NOT_ASSIGNED',
);
assert.equal(unassignedNetworkCalled, false);

let postCallRequest;
const postCall = await reportPostCall(runtimeProfile, { event: 'call.completed', call }, {
  fetchImpl: async (url, request) => {
    postCallRequest = { url, request };
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  },
});
assert.equal(postCall.delivered, true);
assert.equal(postCallRequest.url, 'https://crm.example.test/call-completed');
assert.equal(JSON.parse(postCallRequest.request.body).call.tenantId, 'tenant-a');
assert.ok(postCall.durationMs >= 0);

const invalidPostCall = await reportPostCall({
  ...runtimeProfile,
  integrations: { ...runtimeProfile.integrations, postCall: { api: { active: true, url: 'file:///secret' } } },
}, { event: 'call.completed', call });
assert.equal(invalidPostCall.delivered, false);
assert.match(invalidPostCall.error, /HTTP or HTTPS/);

console.log(JSON.stringify({ success: true, task: 'Voice knowledge, tools and persistence integrations' }));
