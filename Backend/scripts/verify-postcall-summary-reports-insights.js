import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getTenantInsights } from '../src/insights/insight.service.js';

const queries = [];
const responses = [
  [{
    total_calls: 10, answered_calls: 9, completed_calls: 8, unsuccessful_calls: 2,
    sentiment_calls: 7, positive_calls: 5, negative_calls: 1, transcript_calls: 9,
    summarized_calls: 6, summary_failed_calls: 1, follow_up_required_calls: 2,
    average_duration_seconds: 42.5,
  }],
  [{ name: 'positive', value: 5 }, { name: 'unknown', value: 3 }],
  [{ name: 'appointment_booked', value: 4 }, { name: 'completed', value: 3 }],
  [{
    agent_id: 'agent-1', agent_name: 'Hospital Agent', total_calls: 10, completed_calls: 8,
    negative_calls: 1, summarized_calls: 6, follow_up_required_calls: 2,
    average_duration_seconds: 42.5,
  }],
  [{
    id: 'call-1', provider_call_id: 'plivo-1', agent_id: 'agent-1', agent_name: 'Hospital Agent',
    direction: 'outbound', status: 'completed', sentiment: 'neutral', started_at: new Date(),
    duration_seconds: 40, from_number: '+918000000000', to_number: '+919000000000',
    failure_reason: null, customer_excerpt: 'Please call tomorrow.', summary_status: 'completed',
    ai_summary: 'Customer requested a callback.', ai_outcome: 'callback_requested',
    customer_intent: 'Schedule callback', follow_up_required: true, follow_up_reason: 'Call tomorrow',
  }],
];

const report = await getTenantInsights({ tenantId: 'tenant-1' }, { days: 30 }, {
  contextRunner: async (auth, operation) => {
    assert.equal(auth.tenantId, 'tenant-1');
    let index = 0;
    return operation({
      query: async (sql, values) => {
        queries.push(sql);
        assert.deepEqual(values, ['tenant-1', 30]);
        return { rows: responses[index++], rowCount: responses[index - 1].length };
      },
    });
  },
});

assert.equal(report.summary.summaryCoverage, 60);
assert.equal(report.summary.summarizedCalls, 6);
assert.equal(report.summary.summaryFailedCalls, 1);
assert.equal(report.summary.followUpRequiredCalls, 2);
assert.equal(report.outcomes[0].name, 'appointment_booked');
assert.equal(report.agents[0].summarizedCalls, 6);
assert.equal(report.flaggedCalls[0].followUpRequired, true);
assert.equal(report.flaggedCalls[0].aiSummary, 'Customer requested a callback.');
for (const sql of queries) {
  assert.match(sql, /c\.tenant_id=\$1/);
  assert.match(sql, /s\.tenant_id=c\.tenant_id/);
}

const callService = await readFile(new URL('../src/calls/call.service.js', import.meta.url), 'utf8');
assert.match(callService, /s\.call_session_id=c\.id AND s\.tenant_id=c\.tenant_id/);
assert.match(callService, /aiSummary:/);

console.log(JSON.stringify({
  success: true,
  task: 'Post-Call Summary Tasks 9 and 10 - tenant Reports and AI Insights',
}));
