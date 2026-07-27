import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const {
  buildTenantIsolatedContextKey,
  createContextCachePolicy,
  publicContextCacheMetadata,
} = await import('../src/voice/interaction/context-cache-policy.js');

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
};

function profile(cachePolicy, overrides = {}) {
  return { agent: {
    id: overrides.agentId ?? ids.agent,
    tenantId: overrides.tenantId ?? ids.tenant,
    workspaceId: overrides.workspaceId ?? ids.workspace,
    settings: {},
    speech: { interaction: { cachePolicy, greetingMode: 'agent_initiates', contextId: null } },
  } };
}

const contextResolution = { contextId: 'crm:customer-123', source: 'outbound_context_id' };
const persistentA = createContextCachePolicy({
  runtimeProfile: profile('persistent_24h'), call: { id: 'call-a' }, contextResolution,
}, { prefix: 'test', persistentTtlSeconds: 86400 });
const persistentRetry = createContextCachePolicy({
  runtimeProfile: profile('persistent_24h'), call: { id: 'call-b' }, contextResolution,
}, { prefix: 'test', persistentTtlSeconds: 86400 });
assert.equal(persistentA.key, persistentRetry.key);
assert.equal(persistentA.scope, 'persistent');
assert.equal(persistentA.crossCall, true);
assert.equal(persistentA.ttlSeconds, 86400);
assert.equal(persistentA.deleteOnCallEnd, false);
assert.doesNotMatch(persistentA.key, /customer-123/);

for (const changedProfile of [
  profile('persistent_24h', { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  profile('persistent_24h', { workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  profile('persistent_24h', { agentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
]) {
  const isolated = createContextCachePolicy({
    runtimeProfile: changedProfile, call: { id: 'call-a' }, contextResolution,
  }, { prefix: 'test' });
  assert.notEqual(isolated.key, persistentA.key);
}

const differentCustomer = createContextCachePolicy({
  runtimeProfile: profile('persistent_24h'), call: { id: 'call-a' },
  contextResolution: { contextId: 'crm:customer-456', source: 'outbound_context_id' },
}, { prefix: 'test' });
assert.notEqual(differentCustomer.key, persistentA.key);

const sessionA = createContextCachePolicy({
  runtimeProfile: profile('session_only'), call: { id: 'call-a' }, contextResolution,
}, { prefix: 'test', sessionTtlSeconds: 1200 });
const sessionB = createContextCachePolicy({
  runtimeProfile: profile('session_only'), call: { id: 'call-b' }, contextResolution,
}, { prefix: 'test', sessionTtlSeconds: 1200 });
assert.notEqual(sessionA.key, sessionB.key);
assert.equal(sessionA.scope, 'session');
assert.equal(sessionA.crossCall, false);
assert.equal(sessionA.deleteOnCallEnd, true);
assert.equal(sessionA.ttlSeconds, 1200);

const disabled = createContextCachePolicy({
  runtimeProfile: profile('disabled'), call: { id: 'call-a' }, contextResolution,
});
assert.equal(disabled.key, null);
assert.equal(disabled.readEnabled, false);
assert.equal(disabled.writeEnabled, false);
assert.equal(disabled.ttlSeconds, 0);

const legacy = createContextCachePolicy({
  runtimeProfile: { agent: { ...profile('persistent_24h').agent, speech: undefined, settings: { cachePolicy: '24h Persistent' } } },
  call: { id: 'call-legacy' }, contextResolution,
}, { prefix: 'test' });
assert.equal(legacy.policy, 'persistent_24h');
assert.equal(legacy.key, persistentA.key);

const publicMetadata = publicContextCacheMetadata(persistentA);
assert.equal(Object.hasOwn(publicMetadata, 'key'), false);
assert.equal(publicMetadata.policy, 'persistent_24h');

assert.throws(() => buildTenantIsolatedContextKey({
  tenantId: '', workspaceId: ids.workspace, agentId: ids.agent, contextId: contextResolution.contextId,
}, { prefix: 'test' }), (error) => error.code === 'VOICE_CONTEXT_SCOPE_INVALID' && error.field === 'tenantId');

console.log(JSON.stringify({ success: true, task: 'Tenant-isolated context keys and cache policies' }));

