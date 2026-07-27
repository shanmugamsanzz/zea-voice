import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString('base64');

const { createFixture } = await import('./task-16-17-fixture.js');
const { loadAgentRuntimeProfile } = await import('../src/voice/providers/provider-config.js');

const fixture = await createFixture('tools');
try {
  const companyA = await fixture.company('assignment-a');
  const companyB = await fixture.company('assignment-b');
  const agentA = await fixture.agent(companyA);
  const agentB = await fixture.agent(companyB);

  const createResponse = await fixture.api(fixture.base, `/agents/${agentA.id}/tools`, {
    method: 'POST', headers: companyA.headers,
    body: JSON.stringify({
      name: 'check_slots', type: 'webhook_api', status: 'active',
      description: 'Check appointment slot availability',
      configuration: {
        version: 1, url: 'https://tools.example.test/check-slots', method: 'POST', timeoutMs: 5000,
        headers: { 'content-type': 'application/json' },
        inputSchema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'], additionalProperties: false },
        responseMode: 'synchronous',
      },
    }),
  });
  assert.equal(createResponse.status, 201);
  const tool = (await createResponse.json()).data;
  assert.equal(tool.agentId, agentA.id);

  const ownList = await fixture.api(fixture.base, `/agents/${agentA.id}/tools`, { headers: companyA.headers });
  assert.equal(ownList.status, 200);
  assert.equal((await ownList.json()).data.length, 1);

  const crossCompanyList = await fixture.api(fixture.base, `/agents/${agentA.id}/tools`, { headers: companyB.headers });
  assert.equal(crossCompanyList.status, 404);
  const crossAgentTest = await fixture.api(fixture.base, `/agents/${agentB.id}/tools/${tool.id}/test`, {
    method: 'POST', headers: companyB.headers, body: JSON.stringify({ arguments: { date: '2026-07-27' } }),
  });
  assert.equal(crossAgentTest.status, 404);

  const resolvedAgent = {
    agentId: agentA.id, tenantId: companyA.tenantId, workspaceId: companyA.workspaceId, callDirection: 'outbound',
  };
  let profile = await loadAgentRuntimeProfile(resolvedAgent);
  assert.equal(profile.tools.length, 1);
  assert.equal(profile.tools[0].id, tool.id);

  const deactivate = await fixture.api(fixture.base, `/agents/${agentA.id}/tools/${tool.id}/status`, {
    method: 'PATCH', headers: companyA.headers, body: JSON.stringify({ status: 'inactive' }),
  });
  assert.equal(deactivate.status, 200);
  assert.equal((await deactivate.json()).data.status, 'inactive');
  profile = await loadAgentRuntimeProfile(resolvedAgent);
  assert.equal(profile.tools.length, 0);

  const activate = await fixture.api(fixture.base, `/agents/${agentA.id}/tools/${tool.id}/status`, {
    method: 'PATCH', headers: companyA.headers, body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(activate.status, 200);
  profile = await loadAgentRuntimeProfile(resolvedAgent);
  assert.equal(profile.tools.length, 1);

  console.log(JSON.stringify({
    success: true, assignedAgent: 'verified', tenantIsolation: 'verified',
    inactiveRuntimeExclusion: 'verified', activeRuntimeLoading: 'verified',
  }));
} finally {
  await fixture.cleanup();
}
