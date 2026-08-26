import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createBrowserTestSession, endBrowserTestSession } =
  await import('../src/voice/browser-test-session.service.js');
const { validateBrowserTestMediaToken } = await import('../src/voice/browser-test-token.js');

const secret = 'browser-session-isolation-secret-at-least-32-characters';
const now = new Date('2026-08-26T10:00:00.000Z');
const companies = Array.from({ length: 3 }, (_, companyIndex) => {
  const prefix = String(companyIndex + 3);
  const tenantId = `${prefix}0000000-0000-4000-8000-000000000001`;
  const workspaceId = `${prefix}0000000-0000-4000-8000-000000000002`;
  const userId = `${prefix}0000000-0000-4000-8000-000000000003`;
  return {
    tenantId, workspaceId, userId,
    agents: Array.from({ length: 3 }, (_value, agentIndex) => ({
      id: `${prefix}0000000-0000-4000-8000-00000000000${agentIndex + 4}`,
      name: `Synthetic agent ${companyIndex + 1}-${agentIndex + 1}`,
      status: 'active', usage_direction: 'both',
    })),
  };
});
const agents = new Map(companies.flatMap((company) => company.agents.map((agent) => [
  `${company.tenantId}:${company.workspaceId}:${agent.id}`, agent,
])));
const calls = new Map();

async function contextRunner(_auth, operation) {
  return operation({
    async query(sql, parameters = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('FROM voice_agents')) {
        const agent = agents.get(`${parameters[0]}:${parameters[1]}:${parameters[2]}`);
        return { rowCount: agent ? 1 : 0, rows: agent ? [agent] : [] };
      }
      if (sql.includes("SET status='failed'")) {
        assert.match(sql, /jsonb_set\(provider_metadata,'\{browserTest,expired\}'/u);
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT count(*)::int AS count')) {
        const count = [...calls.values()].filter((call) => call.tenant_id === parameters[0]
          && ['ringing', 'connected'].includes(call.status) && !call.ended_at).length;
        return { rowCount: 1, rows: [{ count }] };
      }
      if (sql.includes('INSERT INTO call_sessions')) {
        const metadata = JSON.parse(parameters[10]);
        assert.equal(metadata.source, 'browser_test');
        const row = {
          id: parameters[0], tenant_id: parameters[1], workspace_id: parameters[2],
          provider_call_id: parameters[3], agent_id: parameters[4], agent_name: parameters[5],
          from_number: parameters[6], to_number: parameters[7], direction: parameters[8],
          status: 'ringing', answered_at: null, started_at: parameters[9], ended_at: null,
          duration_seconds: 0, provider_metadata: metadata, credit_billing_finalized: true,
        };
        calls.set(row.id, row);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes('SELECT * FROM call_sessions')) {
        const row = calls.get(parameters[0]);
        const scoped = row && row.tenant_id === parameters[1] && row.workspace_id === parameters[2]
          && row.agent_id === parameters[3] && row.provider_metadata.source === parameters[4];
        return { rowCount: scoped ? 1 : 0, rows: scoped ? [row] : [] };
      }
      if (sql.includes('UPDATE call_sessions') && sql.includes("'canceled'::call_status")) {
        const row = calls.get(parameters[0]);
        assert.match(sql, /jsonb_set\(provider_metadata,'\{browserTest,endedByUser\}'/u);
        const initiatingUserId = row.provider_metadata.browserTest.userId;
        row.status = 'canceled'; row.ended_at = now; row.credit_billing_finalized = true;
        row.provider_metadata.browserTest.endedByUser = true;
        assert.equal(row.provider_metadata.browserTest.userId, initiatingUserId,
          'ending a test must preserve the RLS-scoped initiating user');
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected session-isolation query: ${sql}`);
    },
  });
}

const created = [];
for (const company of companies) {
  const auth = { tenantId: company.tenantId, workspaceId: company.workspaceId,
    userId: company.userId };
  for (const agent of company.agents.slice(0, 2)) {
    const session = await createBrowserTestSession(auth, agent.id, { direction: 'inbound' }, {
      contextRunner, now: () => now, concurrencyLimit: 2,
      tokenOptions: { secret, now: now.getTime() },
    });
    const claims = validateBrowserTestMediaToken(session.token, session.callId,
      { secret, now: now.getTime() });
    assert.equal(claims.tenantId, company.tenantId);
    assert.equal(claims.workspaceId, company.workspaceId);
    assert.equal(claims.agentId, agent.id);
    assert.equal(claims.userId, company.userId);
    assert.equal(calls.get(session.callId).credit_billing_finalized, true);
    created.push({ company, agent, auth, session });
  }
  await assert.rejects(() => createBrowserTestSession(auth, company.agents[2].id, {}, {
    contextRunner, now: () => now, concurrencyLimit: 2,
    tokenOptions: { secret, now: now.getTime() },
  }), (error) => error.code === 'BROWSER_TEST_CONCURRENCY_LIMIT');
}

const owner = created[0];
const foreignCompany = companies[1];
await assert.rejects(() => createBrowserTestSession({
  tenantId: foreignCompany.tenantId, workspaceId: foreignCompany.workspaceId,
  userId: foreignCompany.userId,
}, owner.agent.id, {}, {
  contextRunner, now: () => now, concurrencyLimit: 3,
  tokenOptions: { secret, now: now.getTime() },
}), (error) => error.code === 'BROWSER_TEST_AGENT_NOT_FOUND');

await assert.rejects(() => endBrowserTestSession({
  tenantId: foreignCompany.tenantId, workspaceId: foreignCompany.workspaceId,
  userId: foreignCompany.userId,
}, owner.agent.id, owner.session.testCallId, { contextRunner }),
(error) => error.code === 'BROWSER_TEST_SESSION_NOT_FOUND');

const ended = await endBrowserTestSession(owner.auth, owner.agent.id,
  owner.session.testCallId, { contextRunner });
assert.equal(ended.status, 'canceled');
assert.ok(calls.get(owner.session.testCallId).ended_at);
assert.equal(calls.get(owner.session.testCallId).provider_metadata.browserTest.userId,
  owner.auth.userId);
assert.equal(calls.get(owner.session.testCallId).provider_metadata.browserTest.endedByUser, true);

console.log(JSON.stringify({ success: true, task: 'browser test session isolation',
  companies: companies.length, agentsTested: created.length, concurrentPerCompany: 2,
  scopedTokens: true, unauthorizedCreateRejected: true, unauthorizedEndRejected: true,
  concurrencyEnforced: true, disconnectCleanupPersisted: true, nonBillable: true }));
