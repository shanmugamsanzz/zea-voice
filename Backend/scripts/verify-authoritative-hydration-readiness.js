import assert from 'node:assert/strict';
import { assertCompleteAuthoritativeHydration } from '../src/knowledge-bases/grounded-turn-evidence.js';
import { schedulePublishedArtifactRecovery } from '../src/knowledge-bases/authoritative-artifact-recovery.js';

const tenantId = 'a8000000-0000-4000-8000-000000000001';
const agentId = 'a8000000-0000-4000-8000-000000000002';
const knowledgeBaseId = 'a8000000-0000-4000-8000-000000000003';
const documentId = 'a8000000-0000-4000-8000-000000000004';
const documentVersionId = 'a8000000-0000-4000-8000-000000000005';
const recordId = 'a8000000-0000-4000-8000-000000000006';
const input = { tenantId, agentId };
const source = Object.freeze({
  id: `published:faq:${recordId}`,
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId, recordType: 'FAQ', documentId, documentVersionId,
  documentStatus: 'ready', documentVersionStatus: 'ready',
  documentVersionIsCurrent: true, hydrationValidated: true, publicationValidated: true,
  provenance: Object.freeze({
    tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
    recordId, recordType: 'FAQ', documentId, documentVersionId,
  }),
});

assert.doesNotThrow(() => assertCompleteAuthoritativeHydration({
  hydrationQueryCount: 1,
  evidence: [source],
  comparisonCoverage: { missingRecordIds: [] },
}, input));

assert.throws(() => assertCompleteAuthoritativeHydration({
  hydrationQueryCount: 1,
  evidence: [{ ...source, documentVersionId: null }],
  comparisonCoverage: { missingRecordIds: [] },
}, input, { intentClass: 'COMPARISON_COMPLEX' }), (error) => (
  error.code === 'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE'
  && error.details.records[0].missingFields.includes('documentVersionId')
));

assert.throws(() => assertCompleteAuthoritativeHydration({
  hydrationQueryCount: 1,
  evidence: [source],
  comparisonCoverage: { missingRecordIds: ['missing-comparison-record'] },
}, input, { intentClass: 'COMPARISON_COMPLEX' }), (error) => (
  error.code === 'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE'
  && error.details.missingComparisonRecordIds[0] === 'missing-comparison-record'
));

let queued = 0;
let insertedMetadata = null;
const recovery = await schedulePublishedArtifactRecovery(
  { tenantId },
  [{ tenantId, knowledgeBaseId, publicationRevision: 4 }],
  'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE',
  {
    contextRunner: async (_auth, callback) => callback({
      query: async (sql, parameters) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
        if (sql.includes("status IN ('queued','running')")) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO knowledge_processing_jobs')) {
          insertedMetadata = JSON.parse(parameters[2]);
          return { rowCount: 1, rows: [{ id: 'recovery-job-1', max_attempts: 3 }] };
        }
        if (sql.includes('UPDATE knowledge_processing_jobs')) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected recovery SQL: ${sql}`);
      },
    }),
    enqueueProcessingJob: async ({ processingJobId }) => {
      queued += 1;
      assert.equal(processingJobId, 'recovery-job-1');
      return { id: 'queue-job-1' };
    },
  },
);

assert.equal(recovery.length, 1);
assert.equal(recovery[0].scheduled, true);
assert.equal(recovery[0].queued, true);
assert.equal(queued, 1);
assert.equal(insertedMetadata.publicationRevision, 4);
assert.equal(insertedMetadata.artifactRecovery, true);
assert.equal(insertedMetadata.recoveryReason, 'KNOWLEDGE_AUTHORITATIVE_PROVENANCE_INCOMPLETE');

console.log('Single authoritative hydration gate and revision-scoped recovery verified.');
