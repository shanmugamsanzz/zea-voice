import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.POSTCALL_SUMMARY_WORKERS_ENABLED = 'true';

const {
  createQueuedPostCallSummaryJob,
  listRecoverablePostCallSummaryJobs,
} = await import('../src/voice/postcall-summary/postcall-summary-job.service.js');
const {
  enqueuePostCallSummaryJob,
  queuePostCallSummary,
  requeuePendingPostCallSummaryJobs,
} = await import('../src/voice/postcall-summary/postcall-summary.queue.js');
const {
  closePostCallSummaryWorker,
  startPostCallSummaryWorker,
} = await import('../src/voice/postcall-summary/postcall-summary.worker.js');

const migration = await readFile(new URL('../migrations/1785700000000_post-call-ai-summaries.js', import.meta.url), 'utf8');
for (const required of [
  'call_ai_summaries_call_unique',
  'call_ai_summaries_workspace_fk',
  'call_ai_summaries_call_fk',
  'call_ai_summaries_agent_fk',
  'ENABLE ROW LEVEL SECURITY',
  'FORCE ROW LEVEL SECURITY',
  'tenant_id=zea_current_tenant_id()',
]) assert.ok(migration.includes(required), `Migration is missing ${required}`);

let createValues;
const created = await createQueuedPostCallSummaryJob('call-1', {
  maxAttempts: 4,
  contextRunner: async (operation) => operation({
    async query(sql, values) {
      assert.match(sql, /JOIN voice_agents a ON a\.tenant_id=c\.tenant_id/);
      assert.match(sql, /ON CONFLICT \(call_session_id\) DO NOTHING/);
      createValues = values;
      return { rowCount: 1, rows: [{
        id: 'summary-1', tenant_id: 'tenant-a', workspace_id: 'workspace-a',
        call_session_id: 'call-1', agent_id: 'agent-a', provider_id: 'provider-a', model_id: 'model-a',
        status: 'queued', instructions: 'Summarize facts', include_transcript_in_webhook: true,
        include_summary_in_webhook: true, attempt_count: 0, max_attempts: 4,
        bullmq_job_id: null, newly_created: true,
      }] };
    },
  }),
});
assert.deepEqual(createValues, ['call-1', 4]);
assert.equal(created.tenantId, 'tenant-a');
assert.equal(created.newlyCreated, true);

const noConfiguration = await createQueuedPostCallSummaryJob('call-2', {
  contextRunner: async (operation) => operation({
    query: async (sql) => sql.startsWith('SELECT ended_at')
      ? { rowCount: 1, rows: [{ ended_at: new Date() }] }
      : { rowCount: 0, rows: [] },
  }),
});
assert.equal(noConfiguration, null);

const recoverable = await listRecoverablePostCallSummaryJobs({
  contextRunner: async (userId, operation) => {
    assert.equal(userId, null);
    return operation({ query: async (_sql, values) => ({ rowCount: 1, rows: [{
      id: 'summary-recover', tenant_id: 'tenant-a', workspace_id: 'workspace-a',
      call_session_id: 'call-3', agent_id: 'agent-a', provider_id: 'provider-a', model_id: 'model-a',
      status: 'queued', instructions: 'Facts', include_transcript_in_webhook: true,
      include_summary_in_webhook: true, attempt_count: 0, max_attempts: 3,
      bullmq_job_id: null, queryLimit: values[0],
    }] }) });
  },
  limit: 25,
});
assert.equal(recoverable[0].id, 'summary-recover');

let queueAdd;
const direct = await enqueuePostCallSummaryJob({ summaryJobId: 'summary-1', maxAttempts: 4 }, {
  queue: { add: async (name, data, options) => {
    queueAdd = { name, data, options };
    return { id: 'bull-summary-1' };
  } },
});
assert.equal(direct.id, 'bull-summary-1');
assert.equal(queueAdd.options.jobId, 'summary-1');
assert.equal(queueAdd.options.attempts, 4);
assert.equal(queueAdd.options.backoff.type, 'exponential');

let attached;
const queued = await queuePostCallSummary('call-1', {
  createJob: async () => ({ ...created, newlyCreated: true }),
  queue: { add: async () => ({ id: 'bull-summary-1' }) },
  attachJob: async (summaryJobId, bullmqJobId) => {
    attached = { summaryJobId, bullmqJobId };
    return { ...created, bullmqJobId };
  },
  recordQueueFailure: async () => assert.fail('Queue failure must not be recorded'),
});
assert.equal(queued.queued, true);
assert.deepEqual(attached, { summaryJobId: 'summary-1', bullmqJobId: 'bull-summary-1' });

const alreadyQueued = await queuePostCallSummary('call-1', {
  createJob: async () => ({ ...created, bullmqJobId: 'existing-bull-job', newlyCreated: false }),
  queue: { add: async () => assert.fail('An idempotently queued summary must not be added twice') },
});
assert.equal(alreadyQueued.queued, true);
assert.equal(alreadyQueued.reason, 'already_queued');

let queueFailureRecorded = false;
await assert.rejects(queuePostCallSummary('call-1', {
  createJob: async () => ({ ...created, newlyCreated: false }),
  queue: { add: async () => { throw new Error('Redis unavailable'); } },
  recordQueueFailure: async (_id, error) => { queueFailureRecorded = error.message === 'Redis unavailable'; },
}), /Redis unavailable/);
assert.equal(queueFailureRecorded, true);

let recoveryFailure;
const requeued = await requeuePendingPostCallSummaryJobs({
  listJobs: async () => [
    { ...created, id: 'recover-1' },
    { ...created, id: 'recover-2' },
  ],
  queue: { add: async (_name, data) => {
    if (data.summaryJobId === 'recover-2') throw new Error('Temporary Redis error');
    return { id: data.summaryJobId };
  } },
  attachJob: async () => {},
  recordQueueFailure: async (id) => { recoveryFailure = id; },
});
assert.equal(requeued, 1);
assert.equal(recoveryFailure, 'recover-2');

let fakeWorker;
class FakeWorker {
  constructor(name, processor, options) {
    this.name = name; this.processor = processor; this.options = options; this.listeners = {};
    fakeWorker = this;
  }
  on(name, listener) { this.listeners[name] = listener; }
  async close() { this.closed = true; }
}
let processed;
await startPostCallSummaryWorker(async (summaryJobId, attempt) => {
  processed = { summaryJobId, attempt };
}, {
  WorkerClass: FakeWorker,
  requeue: async () => 2,
  connection: {},
});
assert.equal(fakeWorker.name, 'post-call-summarization');
await fakeWorker.processor({ data: { summaryJobId: 'summary-worker' }, attemptsMade: 1, opts: { attempts: 3 } });
assert.deepEqual(processed, { summaryJobId: 'summary-worker', attempt: { attempt: 2, maxAttempts: 3 } });
await closePostCallSummaryWorker();
assert.equal(fakeWorker.closed, true);

console.log(JSON.stringify({
  success: true,
  task: 'Post-Call Summary Tasks 4 and 5 - tenant storage and background queue',
}));
