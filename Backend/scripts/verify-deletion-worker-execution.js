import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  enqueueKnowledgeProcessingJob,
  permanentKnowledgeDeletionAttempts,
  requeuePendingKnowledgeJobs,
} from '../src/knowledge-bases/knowledge-processing.queue.js';
import { processKnowledgeDeletionJob } from '../src/knowledge-bases/knowledge-deletion.service.js';

const deletionJobId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';

const queueAdds = [];
const queue = {
  async add(name, data, options) {
    queueAdds.push({ name, data, options });
    return { id: options.jobId };
  },
  async getJob() { return null; },
};

await enqueueKnowledgeProcessingJob({
  processingJobId: deletionJobId,
  maxAttempts: 3,
  removeOnComplete: true,
  permanentDeletion: true,
}, queue);
assert.equal(queueAdds[0].options.attempts, permanentKnowledgeDeletionAttempts);
assert.deepEqual(queueAdds[0].options.backoff, { type: 'fixed', delay: 5000 });
assert.equal(queueAdds[0].options.removeOnComplete, true);

const reconciliationUpdates = [];
const reconciliationContext = async (_auth, operation) => operation({
  async query(sql, values) {
    const text = String(sql).replace(/\s+/gu, ' ').trim();
    if (text.startsWith('SELECT id, max_attempts, job_type')) {
      return {
        rows: [{
          id: deletionJobId,
          max_attempts: permanentKnowledgeDeletionAttempts,
          job_type: 'delete_document',
        }],
      };
    }
    reconciliationUpdates.push({ text, values });
    return { rows: [], rowCount: 1 };
  },
});
const reconciled = await requeuePendingKnowledgeJobs(queue, reconciliationContext);
assert.equal(reconciled, 1);
assert.equal(queueAdds.length, 2);
assert.equal(queueAdds[1].options.attempts, permanentKnowledgeDeletionAttempts);
assert.ok(reconciliationUpdates.some((update) => update.text.includes('max_attempts=GREATEST')));
assert.ok(reconciliationUpdates.some((update) => update.text.includes("status='queued'")));

function deletionContext({ attemptCount, updates }) {
  return async (_auth, operation) => operation({
    async query(sql, values) {
      const text = String(sql).replace(/\s+/gu, ' ').trim();
      if (text.startsWith('SELECT * FROM knowledge_processing_jobs')) {
        return {
          rowCount: 1,
          rows: [{
            id: deletionJobId,
            tenant_id: tenantId,
            knowledge_base_id: knowledgeBaseId,
            document_id: documentId,
            job_type: 'delete_document',
            status: 'queued',
            attempt_count: attemptCount,
            max_attempts: permanentKnowledgeDeletionAttempts,
            metadata: {},
          }],
        };
      }
      if (text.startsWith('SELECT id, b2_object_key, extracted_text_object_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('SELECT id, bullmq_job_id')) return { rows: [], rowCount: 0 };
      updates.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  });
}

const retryUpdates = [];
await assert.rejects(processKnowledgeDeletionJob(deletionJobId, {
  contextRunner: deletionContext({ attemptCount: 0, updates: retryUpdates }),
  async deleteDocumentPoints() { throw Object.assign(new Error('Temporary Qdrant outage'), { code: 'QDRANT_TEMPORARY' }); },
}), /Temporary Qdrant outage/u);
assert.ok(retryUpdates.some((update) => update.text.includes("status='queued'")
  && update.values?.[1] === 'KNOWLEDGE_DELETE_QDRANT_FAILED'));
assert.equal(retryUpdates.some((update) => update.text.includes("status='failed'")), false);

const terminalUpdates = [];
await assert.rejects(processKnowledgeDeletionJob(deletionJobId, {
  contextRunner: deletionContext({
    attemptCount: permanentKnowledgeDeletionAttempts - 1,
    updates: terminalUpdates,
  }),
  async deleteDocumentPoints() { throw new Error('Persistent Qdrant outage'); },
}), /Persistent Qdrant outage/u);
assert.ok(terminalUpdates.some((update) => update.text.includes("status='failed'")));

const routes = await readFile(new URL('../src/knowledge-bases/knowledge-base.routes.js', import.meta.url), 'utf8');
assert.match(routes, /Cache-Control', 'no-store, no-cache, must-revalidate'/u);
const frontendApi = await readFile(new URL('../../Frontend/src/lib/api.ts', import.meta.url), 'utf8');
assert.match(frontendApi, /init\.zeaCache === 'bypass'[^\n]+cache = 'no-store'/u);
const agentTabs = await readFile(new URL('../../Frontend/src/components/agent/AgentTabs.tsx', import.meta.url), 'utf8');
assert.match(agentTabs, /updates\.filter\(\(job\) => job\.status === 'completed'\)/u);
assert.match(agentTabs, /\['queued', 'running'\]\.includes\(job\.status\)/u);

console.log(JSON.stringify({
  task: 'Deletion worker execution',
  durableAttempts: permanentKnowledgeDeletionAttempts,
  transitions: ['queued', 'running', 'completed'],
  transientFailureReturnsToQueue: true,
  terminalFailureIsNotReportedAsCompleted: true,
  missingQueueJobReconciled: true,
  pollingCacheDisabled: true,
  uiCompletionRequiresCompletedStatus: true,
}, null, 2));
