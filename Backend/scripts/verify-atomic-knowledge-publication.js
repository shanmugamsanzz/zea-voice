import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildSemanticPoint,
  processSemanticIndexJob,
  validatePublicationMetadata,
} from '../src/knowledge-bases/semantic-index.service.js';
import {
  buildRevisionSparseIndex,
  cacheCompactKnowledgeMap,
} from '../src/knowledge-bases/knowledge-map.service.js';
import { countTenantPointsByKnowledgeBaseRevision } from '../src/rag/qdrant.client.js';
import { env } from '../src/config/env.js';
import {
  parseKnowledgeBaseInput,
  publishKnowledgeBaseSchema,
} from '../src/knowledge-bases/knowledge-base.schemas.js';

const ids = Array.from({ length: 18 }, (_value, index) => {
  const suffix = String(index + 1).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
});
const recordTypes = ['faq', 'knowledge_chunk', 'catalog_item', 'workflow_rule', 'conversation_node'];
const documentTypes = ['faq', 'general_knowledge', 'catalog', 'workflow_rules', 'conversation_script'];
const records = recordTypes.map((recordType, index) => ({
  record_id: ids[index + 8], record_type: recordType,
  document_id: ids[index + 3], document_version_id: ids[index + 13],
  usage_direction: 'both', language: index % 2 ? 'ta' : 'en',
  content: `Approved ${recordType} evidence`, source_page_start: 1,
  question: recordType === 'faq' ? 'Approved question?' : null,
  answer: recordType === 'faq' ? 'Approved answer.' : null,
  entity_aliases: [], entity_category_aliases: [], entity_metadata: {},
}));
const versions = documentTypes.map((documentType, index) => ({
  document_id: ids[index + 3], document_type: documentType,
  document_version_id: ids[index + 13],
  b2_object_key: `tenant/document-${index}/original.txt`,
  extracted_text_object_key: `tenant/document-${index}/extracted.txt`,
  size_bytes: 100 + index,
}));
const job = {
  id: ids[2], tenant_id: ids[0], knowledge_base_id: ids[1],
  status: 'queued', knowledge_base_status: 'processing', publication_revision: 0,
  pending_publication_revision: 1, knowledge_base_usage: 'both',
  assigned_agent_ids: [ids[7]], targetRevision: 1, attempt_count: 0, max_attempts: 1,
  metadata: {
    publicationRevision: 1, requestedBy: ids[6], workspaceId: ids[5], actorType: 'user',
    documentIds: versions.map((version) => version.document_id),
    documentVersionIds: versions.map((version) => version.document_version_id),
  },
};
const points = records.map((record) => buildSemanticPoint(
  job, record, Array.from({ length: env.EMBEDDING_DIMENSIONS }, () => 0.01),
));
assert.deepEqual(validatePublicationMetadata(job, records, points, versions), {
  recordCount: 5, documentCount: 5, verified: true,
});
assert.deepEqual(new Set(points.map((point) => point.payload.document_type)),
  new Set(documentTypes.map((type) => type.toUpperCase())));
assert.ok(points.every((point) => point.payload.tenant_id === job.tenant_id
  && point.payload.knowledge_base_id === job.knowledge_base_id
  && point.payload.publication_revision === 1));
assert.throws(() => validatePublicationMetadata(job, records, [
  { ...points[0], payload: { ...points[0].payload, publication_revision: 99 } }, ...points.slice(1),
], versions), /metadata validation/u);

const replacementManifest = parseKnowledgeBaseInput(publishKnowledgeBaseSchema, {
  replaceCurrentDocuments: true,
  documentIds: versions.map((version) => version.document_id),
});
assert.equal(replacementManifest.success, true);
assert.equal(replacementManifest.data.documentIds.length, 5);
assert.equal(parseKnowledgeBaseInput(publishKnowledgeBaseSchema, {
  replaceCurrentDocuments: true,
}).success, false);
assert.equal(parseKnowledgeBaseInput(publishKnowledgeBaseSchema, {
  replaceCurrentDocuments: true,
  documentIds: [versions[0].document_id, versions[0].document_id],
}).success, false);

const sparse = buildRevisionSparseIndex(job, records);
assert.equal(sparse.algorithm, 'bm25');
assert.equal(sparse.publicationRevision, 1);
assert.equal(sparse.documentCount, 5);
assert.ok(sparse.documents.every((document) => document.tenantId === job.tenant_id
  && document.documentId && document.documentVersionId));

class FakeRedis {
  status = 'ready';
  values = new Map();
  async set(key, value) { this.values.set(key, value); return 'OK'; }
  async get(key) { return this.values.get(key) ?? null; }
  async del(...keys) { let count = 0; for (const key of keys) count += this.values.delete(key) ? 1 : 0; return count; }
  async exists(key) { return this.values.has(key) ? 1 : 0; }
}
const fakeRedis = new FakeRedis();
const artifacts = await cacheCompactKnowledgeMap(job, records, fakeRedis);
assert.equal(artifacts.verified, true);
assert.match(artifacts.keys.map, /:1$/u);
assert.match(artifacts.keys.sparse, /:1$/u);
assert.match(artifacts.keys.evidence, /:1$/u);
assert.equal(JSON.parse(await fakeRedis.get(artifacts.keys.sparse)).publicationRevision, 1);

function fakeContext({ authoritativeCount = records.length } = {}) {
  const state = { activated: false, recovered: false, jobStatus: 'queued' };
  const client = { async query(sql) {
    const query = String(sql);
    if (query.includes('SELECT tenant_id, knowledge_base_id FROM knowledge_processing_jobs')) {
      return { rowCount: 1, rows: [{ tenant_id: job.tenant_id, knowledge_base_id: job.knowledge_base_id }] };
    }
    if (query.includes('SELECT id FROM knowledge_bases')) return { rowCount: 1, rows: [{ id: job.knowledge_base_id }] };
    if (query.includes('SELECT j.*, kb.status')) return { rowCount: 1, rows: [{ ...job, targetRevision: undefined }] };
    if (query.includes("SET status = 'running'")) { state.jobStatus = 'running'; return { rowCount: 1, rows: [] }; }
    if (query.includes("'faq'::text AS record_type")) return { rowCount: records.length, rows: records };
    if (query.includes('SELECT d.id AS document_id')) return { rowCount: versions.length, rows: versions };
    if (query.includes('SELECT status, publication_revision, pending_publication_revision')) {
      return { rowCount: 1, rows: [{ status: 'processing', publication_revision: 0, pending_publication_revision: 1 }] };
    }
    if (query.includes('SELECT count(*)::int AS record_count')) {
      return { rowCount: 1, rows: [{ record_count: authoritativeCount }] };
    }
    if (query.includes("SET status='published', publication_revision")) {
      state.activated = true; return { rowCount: 1, rows: [] };
    }
    if (query.includes("SET status='ready', pending_publication_revision=NULL")) {
      state.recovered = true; return { rowCount: 1, rows: [] };
    }
    if (query.includes('UPDATE knowledge_processing_jobs') && query.includes('SET status = $4')) {
      state.jobStatus = 'failed'; return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  } };
  return { state, run: (_auth, operation) => operation(client) };
}

function dependencies(context, events) {
  return {
    contextRunner: context.run,
    embed: async (texts) => texts.map(() => Array.from({ length: env.EMBEDDING_DIMENSIONS }, () => 0.01)),
    ensureCollection: async () => ({ created: false }),
    deleteKnowledgeBasePoints: async (_tenantId, _knowledgeBaseId, options) => {
      events.push(`delete:${options.revisionMode}`); return { verified: true, remainingCount: 0 };
    },
    upsertPoints: async (_tenantId, batch) => { events.push(`upsert:${batch.length}`); return { count: batch.length }; },
    countRevisionPoints: async () => ({ count: records.length, verified: true }),
    verifyStorageObject: async ({ key }) => { events.push(`b2:${key}`); return { verified: true }; },
    cacheKnowledgeMap: async () => ({ ...artifacts, verified: true }),
    deleteKnowledgeArtifacts: async () => { events.push('redis-cleanup'); return { verified: true }; },
    invalidateCache: async () => ({ verified: true }),
  };
}

const successContext = fakeContext();
const successEvents = [];
const success = await processSemanticIndexJob(job.id, dependencies(successContext, successEvents));
assert.equal(success.status, 'completed');
assert.equal(successContext.state.activated, true);
assert.equal(successEvents.filter((event) => event.startsWith('b2:')).length, 10);
assert.ok(successEvents.includes('delete:older'));

const failureContext = fakeContext({ authoritativeCount: records.length - 1 });
const failureEvents = [];
await assert.rejects(
  processSemanticIndexJob(job.id, dependencies(failureContext, failureEvents)),
  (error) => error?.code === 'KNOWLEDGE_PUBLICATION_POSTGRES_UNVERIFIED',
);
assert.equal(failureContext.state.activated, false, 'A failed verification must never activate the revision');
assert.equal(failureContext.state.recovered, true, 'Final failure must return the KB to a reviewable state');
assert.ok(failureEvents.includes('delete:equal'), 'Failed Qdrant revision must be removed');
assert.ok(failureEvents.includes('redis-cleanup'), 'Failed Redis revision artifacts must be removed');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ result: { count: 5 }, status: 'ok' }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
try {
  assert.equal((await countTenantPointsByKnowledgeBaseRevision(job.tenant_id, job.knowledge_base_id, 1)).count, 5);
} finally { globalThis.fetch = originalFetch; }

const root = new URL('../', import.meta.url);
const publishSource = await readFile(new URL('src/knowledge-bases/knowledge-review.service.js', root), 'utf8');
const semanticSource = await readFile(new URL('src/knowledge-bases/semantic-index.service.js', root), 'utf8');
const runtimeSource = await readFile(new URL('src/knowledge-bases/knowledge-runtime.service.js', root), 'utf8');
const providerSource = await readFile(new URL('src/voice/providers/provider-config.js', root), 'utf8');
const migrationSource = await readFile(new URL('migrations/1786900000000_atomic-knowledge-publication.js', root), 'utf8');
assert.match(publishSource, /status = 'processing', pending_publication_revision/u);
assert.match(publishSource, /KNOWLEDGE_PUBLICATION_DOCUMENTS_REPLACED/u);
assert.match(publishSource, /SET status='archived'/u);
assert.match(publishSource, /documentIds: rows\.map/u);
assert.ok(semanticSource.indexOf('countRevisionPoints(') < semanticSource.lastIndexOf('finishIndexJob(job'));
assert.match(semanticSource, /pending_publication_revision=NULL/u);
assert.match(runtimeSource, /j\.metadata->>'publicationRevision'=kb\.publication_revision::text/u);
assert.doesNotMatch(runtimeSource, /publicationRevision'\)::int <= kb\.publication_revision/u);
assert.doesNotMatch(providerSource, /kb\.status IN \('published', 'partially_failed'\)/u);
assert.match(migrationSource, /pending_publication_revision > publication_revision/u);

console.log('Atomic five-store Knowledge Base publication and failure recovery verified.');
