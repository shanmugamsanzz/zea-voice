import assert from 'node:assert/strict';
import { completeVoiceCallWithoutRuntime } from '../src/voice/call-completion.service.js';

const call = {
  id: 'call-early-close', tenant_id: 'tenant-1', started_at: new Date(0),
  answered_at: new Date(1000), ended_at: null, duration_seconds: 0,
  provider_metadata: {}, reserved_credits: 1, credit_billing_finalized: false,
};
let billingInput;
let summaryQueued = false;
const result = await completeVoiceCallWithoutRuntime({
  callId: call.id,
  outcome: 'completed',
  reason: 'plivo_stream_stopped_before_ready',
  endedAt: new Date(39_000),
}, {
  contextRunner: async (operation) => operation({
    query: async (sql, values) => {
      if (sql.startsWith('SELECT * FROM call_sessions')) return { rowCount: 1, rows: [call] };
      if (sql.startsWith('UPDATE call_sessions')) {
        Object.assign(call, {
          status: values[1], ended_at: values[2], duration_seconds: values[3],
          provider_metadata: { ...call.provider_metadata, ...JSON.parse(values[4]) },
        });
        return { rowCount: 1, rows: [call] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  }),
  finalizeCreditBilling: async (_client, input) => {
    billingInput = input;
    return { creditsCharged: 1 };
  },
  queuePostCallSummary: async () => { summaryQueued = true; return { queued: true }; },
});

assert.equal(result.idempotent, false);
assert.equal(call.status, 'completed');
assert.equal(call.duration_seconds, 38);
assert.equal(call.provider_metadata.voiceRuntime.finalized, true);
assert.equal(call.provider_metadata.voiceRuntime.degradedFinalization, true);
assert.equal(billingInput.durationSeconds, 38);
assert.equal(summaryQueued, true);

console.log('Pre-runtime media-close terminal fallback verified successfully.');
