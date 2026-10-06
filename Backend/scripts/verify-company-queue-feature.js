import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
process.env.NODE_ENV = 'test';
process.env.VOICE_COMPANY_QUEUE_ENABLED = 'false';
process.env.VOICE_COMPANY_QUEUE_TENANT_IDS = '';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost/test';
process.env.REDIS_HOST ??= 'localhost';
const { isCompanyCallQueueEnabled, requireCompanyCallQueueEnabled, shouldQueueInboundCall } = await import('../src/queues/company-queue-feature.js');
const { assertOutboundQueueSpace } = await import('../src/queues/outbound-queue-capacity.service.js');
const { cancelCompanyQueuedTask } = await import('../src/queues/company-queue.service.js');
const first = '39bea399-9d85-42df-894d-66befc2dd170';
const second = '39bea399-9d85-42df-894d-66befc2dd171';
assert.equal(isCompanyCallQueueEnabled(first), false);
assert.equal(shouldQueueInboundCall({ tenantId: first, direction: 'inbound', queuePoll: false }), false);
assert.equal(shouldQueueInboundCall({ tenantId: first, direction: 'inbound', queuePoll: true }), true);
assert.equal(shouldQueueInboundCall({ tenantId: first, direction: 'outbound', queuePoll: true }), false);
assert.equal(shouldQueueInboundCall({ tenantId: first, direction: 'inbound' }, {
  VOICE_COMPANY_QUEUE_ENABLED: true, VOICE_COMPANY_QUEUE_TENANT_IDS: first,
}), true);
assert.equal(shouldQueueInboundCall({ tenantId: second, direction: 'inbound' }, {
  VOICE_COMPANY_QUEUE_ENABLED: true, VOICE_COMPANY_QUEUE_TENANT_IDS: first,
}), false);
assert.throws(() => requireCompanyCallQueueEnabled(first), e => e.code === 'COMPANY_CALL_QUEUE_DISABLED');
assert.equal(isCompanyCallQueueEnabled(first, { VOICE_COMPANY_QUEUE_ENABLED: true, VOICE_COMPANY_QUEUE_TENANT_IDS: ` ${first} ` }), true);
assert.equal(isCompanyCallQueueEnabled(second, { VOICE_COMPANY_QUEUE_ENABLED: true, VOICE_COMPANY_QUEUE_TENANT_IDS: first }), false);
assert.equal(isCompanyCallQueueEnabled(second, { VOICE_COMPANY_QUEUE_ENABLED: true, VOICE_COMPANY_QUEUE_TENANT_IDS: '' }), true);
await assertOutboundQueueSpace({ query: async () => { throw new Error('Disabled feature queried queue capacity'); } }, first, 100);
await assert.rejects(cancelCompanyQueuedTask({ tenantId: first, role: 'COMPANY_DEVELOPER' }, 'task'), e => e.code === 'COMPANY_CALL_QUEUE_DISABLED');
for (const [flag, allowlist, succeeds] of [['false', '', true], ['true', first, true], ['false', 'not-a-uuid', false], ['tru', '', false]]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, VOICE_COMPANY_QUEUE_ENABLED: flag, VOICE_COMPANY_QUEUE_TENANT_IDS: allowlist }, timeout: 10000,
  });
  assert.equal(result.status === 0, succeeds, `Configuration validation: ${flag}/${allowlist}`);
}
const route = await readFile(new URL('../src/voice/voice.routes.js', import.meta.url), 'utf8');
assert.match(route, /shouldQueueInboundCall/);
assert.match(route, /admission \?\?= await admitAnsweredCall/);
console.log('Queue flag verified: default off, company canary, all-company rollout, rollback drainage and disabled management.');
