import assert from 'node:assert/strict';
import { reconcileStaleVoiceCalls } from '../src/voice/call-reconciliation.service.js';

const now = new Date('2026-07-28T06:20:00.000Z');
const candidate = {
  id: 'call-1', tenant_id: 'tenant-1', provider_call_id: 'provider-1',
  started_at: new Date('2026-07-28T06:00:00.000Z'), answered_at: new Date('2026-07-28T06:00:01.000Z'),
  auth_id: 'auth', auth_token_encrypted: 'encrypted', base_url: 'https://api.plivo.com/v1',
};

let persisted = [];
const common = {
  now: () => now,
  listCandidates: async () => [candidate],
  getCallDetails: async () => ({
    call_uuid: 'provider-1', end_time: '2026-07-28T06:02:41.000Z', bill_duration: 160,
    hangup_cause_name: 'Normal Clearing', hangup_source: 'Caller',
  }),
  persistResolution: async (input, resolution) => {
    persisted.push({ input, resolution });
    return { id: input.id, provider_call_id: input.provider_call_id, status: resolution.status,
      duration_seconds: resolution.durationSeconds };
  },
  queueSummary: async () => ({ queued: true }),
  decryptCredential: () => 'token',
};

const protectedResult = await reconcileStaleVoiceCalls({
  ...common, ownership: { isOwned: async () => true },
});
assert.equal(protectedResult.active, 1);
assert.equal(persisted.length, 0, 'A heartbeating call must never be reconciled');

const completedResult = await reconcileStaleVoiceCalls({
  ...common,
  ownership: { isOwned: async () => false, releaseValidated: async () => true },
});
assert.equal(completedResult.reconciled, 1);
assert.equal(persisted[0].resolution.status, 'completed');
assert.equal(persisted[0].resolution.durationSeconds, 160);
assert.equal(persisted[0].resolution.metadata.source, 'plivo_cdr');

persisted = [];
const deferredResult = await reconcileStaleVoiceCalls({
  ...common,
  now: () => new Date('2026-07-28T06:03:00.000Z'),
  ownership: { isOwned: async () => false, releaseValidated: async () => true },
  getCallDetails: async () => ({ call_uuid: 'provider-1', call_state: 'ANSWER' }),
});
assert.equal(deferredResult.deferred, 1);
assert.equal(persisted.length, 0, 'A provider call without an end time must remain active');

const fallbackResult = await reconcileStaleVoiceCalls({
  ...common,
  ownership: { isOwned: async () => false, releaseValidated: async () => true },
  getCallDetails: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'TEST_PROVIDER_DOWN' }); },
});
assert.equal(fallbackResult.reconciled, 1);
assert.equal(persisted[0].resolution.status, 'failed');
assert.equal(persisted[0].resolution.durationSeconds, 0);
assert.equal(persisted[0].resolution.metadata.source, 'stale_call_watchdog');

console.log('Call reconciliation verification passed.');
