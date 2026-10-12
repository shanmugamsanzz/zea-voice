import assert from 'node:assert/strict';
import {
  scheduleCustomerCallback,
} from '../src/campaigns/customer-callback.service.js';
import { finishAttempt } from '../src/campaigns/campaign-execution.service.js';
import {
  normalizeCallbackSettings,
  resolveCallbackConfiguration,
} from '../src/voice/interaction/callback-config.js';

const configured = resolveCallbackConfiguration({
  callbackEnabled: true,
  callbackMinimumDelaySeconds: 120,
  callbackMaximumDelayDays: 7,
  callbackCloseAfterScheduling: false,
});
assert.equal(configured.minimumDelaySeconds, 120);
assert.equal(configured.maximumDelayDays, 7);
assert.equal(configured.closeAfterScheduling, false);
const normalizedCallback = normalizeCallbackSettings({
  callbackFollowUpOpeningInstructions: 'Legacy value',
  callbackConfirmationInstructions: 'Legacy value',
  callbackClarificationInstructions: 'Legacy value',
  callbackFailureInstructions: 'Legacy value',
});
for (const key of ['callbackFollowUpOpeningInstructions', 'callbackConfirmationInstructions',
  'callbackClarificationInstructions', 'callbackFailureInstructions']) {
  assert.equal(Object.hasOwn(normalizedCallback, key), false);
}
assert.throws(() => resolveCallbackConfiguration({ callbackMaximumDelayDays: 31 }), /between 1 and 30/);
const queries = [];
const queueJobs = [];
const selected = {
  task_id: 'task-1', tenant_id: 'tenant-1', workspace_id: 'workspace-1', campaign_id: 'campaign-1',
  retry_count: 0, max_retries: 3, callback_origin_attempt_id: null,
  callback_scheduled_for: null, attempt_id: 'attempt-1',
};
const contextRunner = async (operation) => operation({
  query: async (sql, values) => {
    queries.push({ sql, values });
    if (/SELECT t\.id AS task_id/.test(sql)) return { rowCount: 1, rows: [selected] };
    return { rowCount: 1, rows: [] };
  },
});
const queue = { add: async (...args) => { queueJobs.push(args); } };
const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
// Structured timestamps still obey configured limits after removing text parsing.
for (const requestedFor of ['invalid', new Date(Date.now() - 60000).toISOString(),
  new Date(Date.now() + 90 * 86400000).toISOString()]) {
  const rejected = await scheduleCustomerCallback({callId:'call-1', tenantId:'tenant-1', requestedFor}, {
    contextRunner: () => assert.fail('Invalid times must not reach the database'), queue,
  });
  assert.equal(rejected.reason, 'callback_time_out_of_range');
}
assert.equal((await scheduleCustomerCallback({callId:'call-1', tenantId:'tenant-1',
  requestedFor:new Date(Date.now()+60000).toISOString(),minimumDelaySeconds:configured.minimumDelaySeconds}, {
    contextRunner: () => assert.fail('Configured minimum must be enforced'), queue,
  })).reason, 'callback_time_out_of_range');
const scheduled = await scheduleCustomerCallback({
  callId: 'call-1', tenantId: 'tenant-1', requestedFor: future,
  requestText: 'call me after five minutes',
}, { contextRunner, queue });
assert.equal(scheduled.scheduled, true);
assert.equal(scheduled.retryCount, 1);
assert.equal(queueJobs.length, 1);
assert.equal(queueJobs[0][0], 'campaign-task');
assert.match(queueJobs[0][2].jobId, /-callback-1$/);
assert.match(queries[0].sql, /c\.tenant_id=\$2/);
assert.deepEqual(queries[0].values, ['call-1', 'tenant-1']);
assert.match(queries[1].sql, /retry_count=\$3/);
assert.equal(queries[1].values[1], 'tenant-1');

const exhausted = await scheduleCustomerCallback({
  callId: 'call-2', tenantId: 'tenant-1', requestedFor: future, requestText: 'call later',
}, {
  contextRunner: async (operation) => operation({
    query: async () => ({ rowCount: 1, rows: [{ ...selected, retry_count: 3, max_retries: 3 }] }),
  }),
  finalizeCreditBilling: async () => ({ creditsCharged: 1 }),
  queue,
});
assert.equal(exhausted.scheduled, false);
assert.equal(exhausted.reason, 'retry_limit_reached');

const otherTenant = await scheduleCustomerCallback({
  callId: 'call-1', tenantId: 'tenant-2', requestedFor: future, requestText: 'call later',
}, {
  contextRunner: async (operation) => operation({ query: async () => ({ rowCount: 0, rows: [] }) }),
  queue,
});
assert.equal(otherTenant.scheduled, false);
assert.equal(otherTenant.reason, 'not_campaign_call');

const finishQueries = [];
const protectedResult = await finishAttempt('attempt-1', 'completed', { durationSeconds: 42 }, {
  contextRunner: async (operation) => operation({
    query: async (sql) => {
      finishQueries.push(sql);
      if (/SELECT a\.\*/.test(sql)) return {
        rowCount: 1,
        rows: [{
          id: 'attempt-1', task_id: 'task-1', campaign_id: 'campaign-1', call_session_id: 'call-1',
          ended_at: null, source: 'realtime', retry_count: 1, max_retries: 3,
          retry_outcomes: ['busy', 'no_answer'], retry_intervals_ms: [300000, 600000, 900000],
          callback_origin_attempt_id: 'attempt-1', callback_scheduled_for: future, task_status: 'queued',
        }],
      };
      return { rowCount: 1, rows: [] };
    },
  }),
  finalizeCreditBilling: async () => ({ creditsCharged: 1 }),
  queue,
});
assert.equal(protectedResult.action, 'callback');
assert.equal(finishQueries.length, 3);
assert.equal(finishQueries.some((sql) => /completed_tasks=completed_tasks\+1/.test(sql)), false);

const automaticQueueJobs = [];
const automaticQueries = [];
const automaticRetry = await finishAttempt('attempt-2', 'no_answer', {}, {
  contextRunner: async (operation) => operation({
    query: async (sql) => {
      automaticQueries.push(sql);
      if (/SELECT a\.\*/.test(sql)) return {
        rowCount: 1,
        rows: [{
          id: 'attempt-2', task_id: 'task-2', campaign_id: 'campaign-1', call_session_id: 'call-2',
          ended_at: null, source: 'realtime', retry_count: 0, max_retries: 3,
          retry_outcomes: ['busy', 'no_answer'], retry_intervals_ms: [300000, 600000, 900000],
          callback_origin_attempt_id: null, callback_scheduled_for: null, task_status: 'running',
        }],
      };
      return { rowCount: 1, rows: [] };
    },
  }),
  finalizeCreditBilling: async () => ({ creditsCharged: 0 }),
  queue: { add: async (...args) => automaticQueueJobs.push(args) },
});
assert.equal(automaticRetry.action, 'retry');
assert.equal(automaticRetry.retryCount, 1);
assert.equal(automaticRetry.delay, 300000);
assert.equal(automaticQueueJobs.length, 1);
assert.equal(automaticQueries.some((sql) => /queue_reason='scheduled'/.test(sql)), true);

let queueFailureContextRuns = 0;
const queueFailure = await scheduleCustomerCallback({
  callId: 'call-3', tenantId: 'tenant-1', requestedFor: future, requestText: 'call me after five minutes',
}, {
  contextRunner: async (operation) => {
    queueFailureContextRuns += 1;
    return operation({
      query: async (sql) => (/SELECT t\.id AS task_id/.test(sql)
        ? { rowCount: 1, rows: [{ ...selected, task_id: 'task-3', attempt_id: 'attempt-3' }] }
        : { rowCount: 1, rows: [] }),
    });
  },
  queue: { add: async () => { throw new Error('Redis unavailable: secret-value-must-not-be-persisted'); } },
});
assert.equal(queueFailure.scheduled, false);
assert.equal(queueFailure.reason, 'queue_unavailable');
assert.equal(queueFailureContextRuns, 2);

console.log(JSON.stringify({ success: true, task: 'LLM memory and retry callback continuity' }));
