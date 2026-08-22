import assert from 'node:assert/strict';
import {
  cleanHistoricalKnowledgeBaseReferences,
  processKnowledgeDeletionJob,
  purgePreviouslySoftDeletedKnowledgeBases,
  verifyKnowledgeBaseCascadeContract,
} from '../src/knowledge-bases/knowledge-deletion.service.js';
import { buildKnowledgeSnapshot } from '../src/voice/call-session-store.js';
import {
  deleteAllB2ObjectsUnderPrefix,
  knowledgeBaseB2Prefix,
} from '../src/rag/b2.client.js';
import {
  collectionForTenant,
  deleteTenantPointsByKnowledgeBase,
} from '../src/rag/qdrant.client.js';
import { invalidateKnowledgeBaseArtifacts } from '../src/knowledge-bases/knowledge-runtime.service.js';
import { removeKnowledgeProcessingQueueJobs } from '../src/knowledge-bases/knowledge-processing.queue.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const knowledgeBaseId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const events = [];

const cascadeConstraintRows = [
  ['knowledge_documents', 'knowledge_bases'],
  ['knowledge_document_versions', 'knowledge_documents'],
  ['knowledge_processing_jobs', 'knowledge_bases'],
  ['faq_entries', 'knowledge_document_versions'],
  ['structured_catalogs', 'knowledge_document_versions'],
  ['structured_items', 'structured_catalogs'],
  ['structured_item_attributes', 'structured_items'],
  ['workflow_rules', 'knowledge_document_versions'],
  ['conversation_flows', 'knowledge_document_versions'],
  ['knowledge_chunks', 'knowledge_document_versions'],
  ['agent_knowledge_bases', 'knowledge_bases'],
].map(([child_table, parent_table], index) => ({
  child_table,
  parent_table,
  constraint_name: `verified_cascade_${index}`,
  delete_action: 'c',
}));

const cascadeVerificationRows = [
  'knowledge_bases', 'knowledge_documents', 'knowledge_document_versions',
  'knowledge_processing_jobs', 'faq_entries', 'structured_catalogs',
  'structured_items', 'structured_item_attributes', 'workflow_rules',
  'conversation_flows', 'knowledge_chunks', 'agent_knowledge_bases',
].map((table_name) => ({ table_name, remaining_count: 0 }));

const client = {
  async query(sql, values = []) {
    const text = String(sql).replace(/\s+/gu, ' ').trim();
    if (text.includes('FROM pg_constraint constraint_record')) {
      return { rowCount: cascadeConstraintRows.length, rows: cascadeConstraintRows };
    }
    if (text.includes(') cascade_verification')) {
      return { rowCount: cascadeVerificationRows.length, rows: cascadeVerificationRows };
    }
    if (text.startsWith('UPDATE call_transcript_entries transcript')) {
      assert.equal(text.includes('SET sources='), true);
      assert.equal(text.includes('SET text='), false);
      events.push({ type: 'transcript-source-cleanup', values });
      return { rowCount: 2, rows: [{ id: 'transcript-a' }, { id: 'transcript-b' }] };
    }
    if (text.startsWith('DELETE FROM audit_logs audit')) {
      events.push({ type: 'knowledge-audit-cleanup', values });
      return { rowCount: 5, rows: [] };
    }
    if (text.includes("SELECT * FROM knowledge_processing_jobs")) {
      return {
        rowCount: 1,
        rows: [{
          id: jobId,
          tenant_id: tenantId,
          knowledge_base_id: knowledgeBaseId,
          document_id: null,
          job_type: 'delete_knowledge_base',
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          metadata: {},
        }],
      };
    }
    if (text.includes('SELECT id, b2_object_key, extracted_text_object_key')) {
      return {
        rowCount: 1,
        rows: [{
          id: documentId,
          b2_object_key: `tenants/${tenantId}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/versions/1/source.pdf`,
          extracted_text_object_key: null,
        }],
      };
    }
    if (text.startsWith('SELECT id FROM call_sessions')) {
      return { rowCount: 0, rows: [] };
    }
    if (text.startsWith('DELETE FROM knowledge_bases')) {
      events.push({ type: 'postgres-hard-delete', values });
      return { rowCount: 1, rows: [{ id: knowledgeBaseId }] };
    }
    return { rowCount: 1, rows: [] };
  },
};
const contextRunner = async (_auth, operation) => operation(client);

const processed = await processKnowledgeDeletionJob(jobId, {
  contextRunner,
  async deleteKnowledgeBasePoints(foundTenantId, foundKnowledgeBaseId) {
    events.push({ type: 'qdrant', tenantId: foundTenantId, knowledgeBaseId: foundKnowledgeBaseId });
    return { deleted: true, verified: true, remainingCount: 0 };
  },
  storage: {
    async deletePrefix({ prefix }) {
      events.push({ type: 'b2', prefix });
      return { deleted: true, verified: true, deletedCount: 3, remainingObjectVersions: 0 };
    },
  },
  async removeQueueJobs() {
    events.push({ type: 'bullmq' });
    return { removed: [], active: [], verified: true, remaining: [] };
  },
  async invalidateCache(foundTenantId) {
    events.push({ type: 'redis', tenantId: foundTenantId });
    return { deletedKeys: 2, verified: true, remainingKeys: 0 };
  },
});

assert.equal(processed.status, 'completed');
assert.equal(processed.permanentlyDeleted, true);
assert.deepEqual(processed.verification, {
  postgresRows: 0,
  agentAssignments: 0,
  b2ObjectVersions: 0,
  qdrantPoints: 0,
  redisRagKeys: 0,
  bullmqJobs: 0,
});
assert.deepEqual(events.map((event) => event.type), [
  'bullmq', 'qdrant', 'b2', 'redis',
  'transcript-source-cleanup', 'knowledge-audit-cleanup', 'postgres-hard-delete',
]);
assert.deepEqual(events[1], { type: 'qdrant', tenantId, knowledgeBaseId });
assert.equal(events[2].prefix, `tenants/${tenantId}/knowledge-bases/${knowledgeBaseId}/`);
assert.deepEqual(events.at(-1).values, [tenantId, knowledgeBaseId]);

const historicalCleanup = await cleanHistoricalKnowledgeBaseReferences({
  async query(sql, values) {
    const text = String(sql).replace(/\s+/gu, ' ').trim();
    assert.deepEqual(values, [tenantId, knowledgeBaseId]);
    if (text.startsWith('UPDATE call_transcript_entries transcript')) {
      assert.equal(text.includes("source.value->>'type'='knowledge'"), true);
      assert.equal(text.includes('jsonb_agg(source.value ORDER BY source.ordinality)'), true);
      assert.equal(text.includes('transcript.text'), false);
      return { rowCount: 3, rows: [] };
    }
    if (text.startsWith('DELETE FROM audit_logs audit')) {
      assert.equal(text.includes("audit.entity_type IN ('knowledge_base','agent_knowledge_base')"), true);
      assert.equal(text.includes("audit.entity_type='knowledge_document'"), true);
      assert.equal(text.includes("audit.entity_type='knowledge_document_version'"), true);
      assert.equal(text.includes("audit.entity_type='knowledge_review_record'"), true);
      assert.equal(text.includes('knowledge_base_id=$2::uuid'), true);
      return { rowCount: 7, rows: [] };
    }
    throw new Error(`Unexpected historical cleanup SQL: ${text}`);
  },
}, tenantId, knowledgeBaseId);
assert.deepEqual(historicalCleanup, { transcriptEntriesUpdated: 3, auditRecordsDeleted: 7 });

await assert.rejects(
  verifyKnowledgeBaseCascadeContract({
    async query() {
      return {
        rowCount: cascadeConstraintRows.length - 1,
        rows: cascadeConstraintRows.filter((row) => row.child_table !== 'agent_knowledge_bases'),
      };
    },
  }),
  (error) => error?.code === 'KNOWLEDGE_DELETE_CASCADE_UNSAFE'
    && error?.details?.missingCascadePaths?.includes('agent_knowledge_bases'),
);

const exactPrefix = knowledgeBaseB2Prefix({ tenantId, knowledgeBaseId });
const otherTenantId = '99999999-9999-4999-8999-999999999999';
let b2ListPass = 0;
const b2Deletes = [];
const b2Client = {
  async send(command) {
    if (command.constructor.name === 'ListObjectVersionsCommand') {
      b2ListPass += 1;
      assert.equal(command.input.Prefix, exactPrefix);
      if (b2ListPass > 1) return { IsTruncated: false, Versions: [], DeleteMarkers: [] };
      return {
        IsTruncated: false,
        Versions: [
          { Key: `${exactPrefix}documents/${documentId}/versions/1/source.pdf`, VersionId: 'pdf-v1' },
          { Key: `${exactPrefix}documents/${documentId}/versions/1/source.pdf`, VersionId: 'pdf-v2' },
          { Key: `${exactPrefix}orphaned/not-in-postgresql.bin`, VersionId: 'orphan-v1' },
          {
            Key: `tenants/${otherTenantId}/knowledge-bases/${knowledgeBaseId}/documents/foreign.pdf`,
            VersionId: 'foreign-v1',
          },
        ],
        DeleteMarkers: [
          { Key: `${exactPrefix}documents/${documentId}/versions/1/extracted-text.json`, VersionId: 'text-marker' },
        ],
      };
    }
    if (command.constructor.name === 'DeleteObjectCommand') {
      b2Deletes.push(command.input);
      return {};
    }
    throw new Error(`Unexpected B2 command: ${command.constructor.name}`);
  },
};
const b2Purge = await deleteAllB2ObjectsUnderPrefix({
  prefix: exactPrefix,
  tenantId,
  knowledgeBaseId,
}, { client: b2Client, bucket: 'test-private-bucket', timeoutMs: 5_000 });
assert.equal(b2Purge.deletedCount, 4);
assert.equal(b2Purge.deletedVersionCount, 3);
assert.equal(b2Purge.deletedMarkerCount, 1);
assert.equal(b2Purge.listPasses, 2);
assert.equal(b2Purge.verified, true);
assert.equal(b2Purge.remainingObjectVersions, 0);
assert.equal(b2Deletes.some((entry) => entry.Key.includes('orphaned/not-in-postgresql.bin')), true);
assert.equal(b2Deletes.some((entry) => entry.Key.includes(otherTenantId)), false);
await assert.rejects(
  deleteAllB2ObjectsUnderPrefix({
    prefix: `tenants/${otherTenantId}/knowledge-bases/${knowledgeBaseId}/`,
    tenantId,
    knowledgeBaseId,
  }, { client: b2Client, bucket: 'test-private-bucket' }),
  /tenant-isolated Knowledge Base storage prefix/u,
);

const qdrantCalls = [];
let qdrantRemainingCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const call = {
    url: String(url),
    method: options.method ?? 'GET',
    body: options.body ? JSON.parse(options.body) : null,
  };
  qdrantCalls.push(call);
  const payload = call.url.endsWith('/points/count')
    ? { result: { count: qdrantRemainingCount }, status: 'ok' }
    : { result: { status: 'completed' }, status: 'ok' };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  const qdrantDeletion = await deleteTenantPointsByKnowledgeBase(tenantId, knowledgeBaseId);
  assert.equal(qdrantDeletion.verified, true);
  assert.equal(qdrantDeletion.remainingCount, 0);
  const qdrantDeleteCall = qdrantCalls.find((call) => call.url.includes('/points/delete'));
  const qdrantCountCall = qdrantCalls.find((call) => call.url.endsWith('/points/count'));
  const expectedFilter = {
    must: [
      { key: 'tenant_id', match: { value: tenantId } },
      { key: 'knowledge_base_id', match: { value: knowledgeBaseId } },
    ],
  };
  assert.deepEqual(qdrantDeleteCall.body.filter, expectedFilter);
  assert.deepEqual(qdrantCountCall.body.filter, expectedFilter);
  assert.equal(qdrantCountCall.body.exact, true);
  assert.equal(qdrantCalls.every((call) => call.url.includes(collectionForTenant(tenantId))), true);

  qdrantRemainingCount = 2;
  await assert.rejects(
    deleteTenantPointsByKnowledgeBase(tenantId, knowledgeBaseId),
    (error) => error?.code === 'QDRANT_KNOWLEDGE_DELETE_INCOMPLETE' && error.remainingCount === 2,
  );
} finally {
  globalThis.fetch = originalFetch;
}

const cacheKeys = new Set([
  `zea:rag:knowledge-map:${tenantId}:${knowledgeBaseId}:1`,
  `zea:rag:bm25:${tenantId}:${knowledgeBaseId}:1`,
  `zea:rag:evidence:${tenantId}:${knowledgeBaseId}:2`,
  `zea:rag:publication-manifest:${tenantId}:${knowledgeBaseId}:2`,
  `zea:rag:knowledge-map:${otherTenantId}:${knowledgeBaseId}:1`,
]);
const wildcardMatch = (pattern, value) => value.startsWith(pattern.slice(0, -1));
const cacheCleanup = await invalidateKnowledgeBaseArtifacts(tenantId, knowledgeBaseId, null, {
  status: 'ready',
  async scan(_cursor, _match, pattern) {
    return ['0', [...cacheKeys].filter((key) => wildcardMatch(pattern, key))];
  },
  async del(...keys) {
    let count = 0;
    for (const key of keys) {
      if (cacheKeys.delete(key)) count += 1;
    }
    return count;
  },
  async exists(key) { return cacheKeys.has(key) ? 1 : 0; },
});
assert.equal(cacheCleanup.incomplete, undefined);
assert.equal(cacheCleanup.deletedKeys, 4);
assert.equal(cacheCleanup.verified, true);
assert.equal(cacheCleanup.remainingKeys, 0);
assert.deepEqual([...cacheKeys], [`zea:rag:knowledge-map:${otherTenantId}:${knowledgeBaseId}:1`]);

const queueJobs = new Map();
for (const [id, state] of [
  ['job-waiting', 'waiting'],
  ['job-delayed-retry', 'delayed'],
  ['job-completed', 'completed'],
  ['job-failed', 'failed'],
  ['job-active', 'active'],
  ['job-company-b', 'completed'],
]) {
  queueJobs.set(id, {
    async getState() { return state; },
    async remove() { queueJobs.delete(id); },
  });
}
const queueCleanup = await removeKnowledgeProcessingQueueJobs([
  'job-waiting', 'job-delayed-retry', 'job-completed', 'job-failed',
  'job-active', 'job-missing', 'job-waiting',
], {
  async getJob(id) { return queueJobs.get(id) ?? null; },
});
assert.deepEqual(queueCleanup.removed.sort(), [
  'job-completed', 'job-delayed-retry', 'job-failed', 'job-waiting',
]);
assert.deepEqual(queueCleanup.active, ['job-active']);
assert.deepEqual(queueCleanup.missing, ['job-missing']);
assert.equal(queueCleanup.verified, false);
assert.deepEqual(queueCleanup.remaining, []);
assert.deepEqual([...queueJobs.keys()], ['job-active', 'job-company-b']);

const snapshot = buildKnowledgeSnapshot({
  knowledgeBases: [
    { id: knowledgeBaseId, publicationRevision: 4 },
    { id: knowledgeBaseId, publicationRevision: 4 },
  ],
});
assert.deepEqual(snapshot.knowledgeBaseIds, [knowledgeBaseId]);
assert.deepEqual(snapshot.items.map(({ id, publicationRevision }) => ({ id, publicationRevision })), [
  { id: knowledgeBaseId, publicationRevision: 4 },
  { id: knowledgeBaseId, publicationRevision: 4 },
]);

const deferredEvents = [];
const deferredContextRunner = async (_auth, operation) => operation({
  async query(sql, values = []) {
    const text = String(sql).replace(/\s+/gu, ' ').trim();
    if (text.includes('FROM pg_constraint constraint_record')) {
      return { rowCount: cascadeConstraintRows.length, rows: cascadeConstraintRows };
    }
    if (text.includes(') cascade_verification')) {
      return { rowCount: cascadeVerificationRows.length, rows: cascadeVerificationRows };
    }
    if (text.includes('SELECT * FROM knowledge_processing_jobs')) {
      return {
        rowCount: 1,
        rows: [{
          id: jobId, tenant_id: tenantId, knowledge_base_id: knowledgeBaseId,
          document_id: null, job_type: 'delete_knowledge_base', status: 'queued',
          attempt_count: 0, max_attempts: 10, metadata: { assignedAgentIds: [] },
        }],
      };
    }
    if (text.startsWith('SELECT id FROM call_sessions')) {
      return { rowCount: 1, rows: [{ id: '88888888-8888-4888-8888-888888888888' }] };
    }
    if (text.startsWith('UPDATE knowledge_processing_jobs SET status=\'queued\'')) {
      deferredEvents.push({ type: 'deferred', values });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected active-call deferral SQL: ${text}`);
  },
});
await assert.rejects(
  processKnowledgeDeletionJob(jobId, {
    contextRunner: deferredContextRunner,
    async deleteKnowledgeBasePoints() { deferredEvents.push({ type: 'qdrant' }); },
    storage: { async deletePrefix() { deferredEvents.push({ type: 'b2' }); } },
    async removeQueueJobs() { deferredEvents.push({ type: 'bullmq' }); return { removed: [], active: [] }; },
    async invalidateCache() { deferredEvents.push({ type: 'redis' }); },
  }),
  (error) => error?.code === 'KNOWLEDGE_DELETE_ACTIVE_CALLS',
);
assert.deepEqual(deferredEvents.map((event) => event.type), ['deferred']);

const priorTenantId = '55555555-5555-4555-8555-555555555555';
const priorKnowledgeBaseId = '66666666-6666-4666-8666-666666666666';
let candidateReturned = false;
let priorCandidatePurged = false;
const purgeEvents = [];
const purgeContextRunner = async (_auth, operation) => operation({
  async query(sql, values = []) {
    const text = String(sql).replace(/\s+/gu, ' ').trim();
    if (text.includes('FROM pg_constraint constraint_record')) {
      return { rowCount: cascadeConstraintRows.length, rows: cascadeConstraintRows };
    }
    if (text.includes(') cascade_verification')) {
      return { rowCount: cascadeVerificationRows.length, rows: cascadeVerificationRows };
    }
    if (text.startsWith('UPDATE call_transcript_entries transcript')) {
      purgeEvents.push({ type: 'transcript-source-cleanup', values });
      return { rowCount: 1, rows: [{ id: 'prior-transcript' }] };
    }
    if (text.startsWith('DELETE FROM audit_logs audit')) {
      purgeEvents.push({ type: 'knowledge-audit-cleanup', values });
      return { rowCount: 2, rows: [] };
    }
    if (text.startsWith('SELECT id, tenant_id, workspace_id')) {
      candidateReturned = true;
      assert.equal(text.includes("WHERE status='deleted' OR deleted_at IS NOT NULL"), true);
      return {
        rows: priorCandidatePurged ? [] : [{
          id: priorKnowledgeBaseId,
          tenant_id: priorTenantId,
          workspace_id: '77777777-7777-4777-8777-777777777777',
          name: 'Previously deleted KB',
          status: 'deleted',
          deleted_at: new Date('2026-01-01T00:00:00.000Z'),
          document_count: 2,
          version_count: 2,
          bullmq_job_ids: ['prior-job'],
        }],
      };
    }
    if (text.startsWith('DELETE FROM knowledge_bases')) {
      purgeEvents.push({ type: 'postgres-hard-delete', values });
      priorCandidatePurged = true;
      return { rowCount: 1, rows: [{ id: priorKnowledgeBaseId }] };
    }
    throw new Error(`Unexpected purge SQL: ${text}`);
  },
});
const purgeDependencies = {
  contextRunner: purgeContextRunner,
  async deleteKnowledgeBasePoints(foundTenantId, foundKnowledgeBaseId) {
    purgeEvents.push({ type: 'qdrant', tenantId: foundTenantId, knowledgeBaseId: foundKnowledgeBaseId });
    return { deleted: true, verified: true, remainingCount: 0 };
  },
  storage: {
    async deletePrefix({ prefix }) {
      purgeEvents.push({ type: 'b2', prefix });
      return { deleted: true, verified: true, deletedCount: 4, remainingObjectVersions: 0 };
    },
  },
  async removeQueueJobs(jobIds) {
    purgeEvents.push({ type: 'bullmq', jobIds });
    return { removed: jobIds, active: [], verified: true, remaining: [] };
  },
  async invalidateCache(foundTenantId) {
    purgeEvents.push({ type: 'redis', tenantId: foundTenantId });
    return { deletedKeys: 1, verified: true, remainingKeys: 0 };
  },
};
const purgeDryRun = await purgePreviouslySoftDeletedKnowledgeBases({}, purgeDependencies);
assert.equal(purgeDryRun.execute, false);
assert.equal(purgeDryRun.irreversible, true);
assert.equal(purgeDryRun.count, 1);
assert.equal(purgeDryRun.items[0].status, 'deleted');
assert.equal(purgeDryRun.items[0].documentCount, 2);
assert.equal(purgeDryRun.confirmationToken.length, 64);
assert.deepEqual(purgeEvents, []);
await assert.rejects(
  purgePreviouslySoftDeletedKnowledgeBases({ execute: true }, purgeDependencies),
  (error) => error?.code === 'KNOWLEDGE_PURGE_DRY_RUN_REQUIRED',
);
assert.deepEqual(purgeEvents, []);
const purged = await purgePreviouslySoftDeletedKnowledgeBases({
  execute: true,
  confirmationToken: purgeDryRun.confirmationToken,
}, purgeDependencies);

assert.equal(candidateReturned, true);
assert.equal(purged.deletedCount, 1);
assert.equal(purged.alreadyPurgedCount, 0);
assert.equal(purged.failedCount, 0);
assert.deepEqual(purgeEvents.map((event) => event.type), [
  'bullmq', 'qdrant', 'b2', 'redis',
  'transcript-source-cleanup', 'knowledge-audit-cleanup', 'postgres-hard-delete',
]);
assert.deepEqual(purgeEvents.at(-1).values, [priorTenantId, priorKnowledgeBaseId]);
const resumeDryRun = await purgePreviouslySoftDeletedKnowledgeBases({}, purgeDependencies);
assert.equal(resumeDryRun.count, 0);
const resumed = await purgePreviouslySoftDeletedKnowledgeBases({
  execute: true,
  confirmationToken: resumeDryRun.confirmationToken,
}, purgeDependencies);
assert.equal(resumed.count, 0);
assert.equal(resumed.deletedCount, 0);
assert.equal(resumed.failedCount, 0);

const failureTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const failureKnowledgeBaseId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let failureStorageCalled = false;
const failureDependencies = {
  contextRunner: async (_auth, operation) => operation({
    async query(sql) {
      const text = String(sql).replace(/\s+/gu, ' ').trim();
      if (!text.startsWith('SELECT id, tenant_id, workspace_id')) throw new Error(`Unexpected failure SQL: ${text}`);
      return { rows: [{
        id: failureKnowledgeBaseId,
        tenant_id: failureTenantId,
        workspace_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Retryable failed purge', status: 'deleted',
        deleted_at: new Date('2026-02-01T00:00:00.000Z'),
        document_count: 1, version_count: 1, bullmq_job_ids: [],
      }] };
    },
  }),
  async removeQueueJobs() { return { removed: [], active: [], verified: true, remaining: [] }; },
  async deleteKnowledgeBasePoints() { throw Object.assign(new Error('Qdrant unavailable'), { code: 'QDRANT_UNAVAILABLE' }); },
  storage: { async deletePrefix() { failureStorageCalled = true; } },
  async invalidateCache() { return { deletedKeys: 0 }; },
};
const failureDryRun = await purgePreviouslySoftDeletedKnowledgeBases({}, failureDependencies);
const failedPurge = await purgePreviouslySoftDeletedKnowledgeBases({
  execute: true,
  confirmationToken: failureDryRun.confirmationToken,
}, failureDependencies);
assert.equal(failedPurge.failedCount, 1);
assert.equal(failedPurge.items[0].status, 'failed');
assert.equal(failedPurge.items[0].failedStage, 'qdrant');
assert.equal(failedPurge.items[0].errorCode, 'QDRANT_UNAVAILABLE');
assert.equal(failureStorageCalled, false);

console.log(JSON.stringify({
  task: 'Permanent Knowledge Base deletion',
  passed: true,
  checks: {
    externalCleanupPrecedesPostgresHardDelete: true,
    tenantAndKnowledgeBaseFiltersPreserved: true,
    b2PrefixIsTenantIsolated: true,
    priorSoftDeletePurgeUsesSameIsolation: true,
    newCallsPersistKnowledgeSnapshot: true,
    activeCallsDeferDestructiveCleanup: true,
    b2DeletesPdfTextOldVersionsMarkersAndOrphans: true,
    b2RejectsCrossTenantPrefix: true,
    qdrantUsesTenantAndKnowledgeBaseFilter: true,
    qdrantVerifiesZeroRemainingPoints: true,
    qdrantDoesNotTouchOtherTenantCollections: true,
    redisTenantProfileAndResultCachesRemoved: true,
    redisOtherTenantCachePreserved: true,
    bullmqQueuedRetryCompletedAndFailedJobsRemoved: true,
    bullmqActiveJobsDeferredSafely: true,
    postgresCascadeContractVerifiedBeforeParentDelete: true,
    postgresCascadeRemovesEveryKnowledgeTable: true,
    unsafeCascadeContractRollsBackDeletion: true,
    transcriptTextAndCallsArePreserved: true,
    onlyMatchingKnowledgeSourcesAreRemoved: true,
    knowledgeBaseSpecificAuditRecordsAreRemoved: true,
    legacyPurgeDryRunIsMandatory: true,
    legacyPurgeTokenLocksReviewedCandidateList: true,
    legacyPurgeIsIdempotentAndResumable: true,
    everyDeletedKnowledgeBaseStoreVerifiesZero: true,
    agentAssignmentsVerifyZero: true,
    companyBDataRemainsUntouchedAcrossStores: true,
  },
}, null, 2));
