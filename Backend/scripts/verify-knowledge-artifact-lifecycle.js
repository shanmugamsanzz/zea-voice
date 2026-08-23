import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import {
  cacheCompactKnowledgeMap,
  answerCardsCacheKey,
} from '../src/knowledge-bases/knowledge-map.service.js';
import { processSemanticIndexJob } from '../src/knowledge-bases/semantic-index.service.js';
import {
  ensurePublishedEngineReady,
  invalidateKnowledgeBaseArtifacts,
  loadPublishedEngineArtifacts,
} from '../src/knowledge-engine/runtime-service.js';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';

const repeatsFlag = process.argv.find((argument) => argument.startsWith('--repeats='));
const repeats = Number(repeatsFlag?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(repeats) && repeats >= 3, 'Artifact lifecycle gate requires at least three passes');

const tenantId = '10000000-0000-4000-8000-000000000001';
const knowledgeBaseA = '20000000-0000-4000-8000-000000000001';
const knowledgeBaseB = '20000000-0000-4000-8000-000000000002';
const agentId = '30000000-0000-4000-8000-000000000001';
const recoveryJobId = '40000000-0000-4000-8000-000000000001';
const documentId = '50000000-0000-4000-8000-000000000001';
const documentVersionId = '60000000-0000-4000-8000-000000000001';
const recordId = '70000000-0000-4000-8000-000000000001';
const prefixes = [
  'knowledge-map', 'bm25', 'evidence', 'entity-index',
  'route-index', 'answer-cards', 'publication-manifest',
];

const wildcard = (pattern, value) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
};

class FakeRedis {
  status = 'ready';
  values = new Map();
  async set(key, value) { this.values.set(key, value); return 'OK'; }
  async get(key) { return this.values.get(key) ?? null; }
  async exists(key) { return this.values.has(key) ? 1 : 0; }
  async del(...keys) {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    return deleted;
  }
  async scan(_cursor, _match, pattern) {
    return ['0', [...this.values.keys()].filter((key) => wildcard(pattern, key))];
  }
}

function publicationJob(knowledgeBaseId, publicationRevision) {
  return {
    tenant_id: tenantId,
    knowledge_base_id: knowledgeBaseId,
    targetRevision: publicationRevision,
    knowledge_base_usage: 'both',
    assigned_agent_ids: [agentId],
  };
}

function publicationRecords(knowledgeBaseId) {
  return [{
    record_id: knowledgeBaseId === knowledgeBaseB ? recordId : '70000000-0000-4000-8000-000000000002',
    record_type: 'catalog_item',
    document_id: documentId,
    document_version_id: documentVersionId,
    usage_direction: 'both',
    language: 'en',
    content: `Approved answer for ${knowledgeBaseId}`,
    source_page_start: 1,
    entity_name: `Item ${knowledgeBaseId.slice(-1)}`,
    entity_category: 'Published category',
    entity_aliases: [],
    entity_category_aliases: [],
    entity_metadata: {},
  }];
}

function artifactKeys(knowledgeBaseId, revision) {
  return prefixes.map((prefix) => `zea:rag:${prefix}:${tenantId}:${knowledgeBaseId}:${revision}`);
}

async function publishToRedis(cache, knowledgeBaseId, revision) {
  const job = publicationJob(knowledgeBaseId, revision);
  const records = publicationRecords(knowledgeBaseId);
  const bundle = buildPublicationIndexes(job, records);
  const result = await cacheCompactKnowledgeMap(job, bundle.records, cache, bundle);
  assert.equal(result.verified, true);
  return { job, records, bundle, result };
}

async function runPass(pass) {
  const cache = new FakeRedis();
  await publishToRedis(cache, knowledgeBaseA, 3);
  const publishedB = await publishToRedis(cache, knowledgeBaseB, 8);
  assert.equal(artifactKeys(knowledgeBaseA, 3).every((key) => cache.values.has(key)), true);
  assert.equal(artifactKeys(knowledgeBaseB, 8).every((key) => cache.values.has(key)), true);

  const deletion = await invalidateKnowledgeBaseArtifacts(tenantId, knowledgeBaseA, null, cache);
  assert.equal(deletion.deletedKeys, 7);
  assert.equal(deletion.verified, true);
  assert.equal(artifactKeys(knowledgeBaseA, 3).some((key) => cache.values.has(key)), false);
  assert.equal(artifactKeys(knowledgeBaseB, 8).every((key) => cache.values.has(key)), true,
    'Deleting KB-A must preserve every KB-B publication artifact');

  const damagedKey = answerCardsCacheKey(tenantId, knowledgeBaseB, 8);
  assert.equal(await cache.del(damagedKey), 1);
  assert.equal(artifactKeys(knowledgeBaseB, 8).filter((key) => cache.values.has(key)).length, 6);

  const recovery = { inserted: false, queued: false, status: 'queued', insertCount: 0 };
  const runtimeContextRunner = async (_auth, operation) => operation({
    async query(sql) {
      const query = String(sql);
      if (query.includes('FROM voice_agents agent')) return {
        rowCount: 1,
        rows: [{ knowledge_base_id: knowledgeBaseB, publication_revision: 8, priority: 1 }],
      };
      if (query.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
      if (query.includes("metadata->>'artifactRecovery'='true'")) {
        return recovery.inserted && ['queued', 'running'].includes(recovery.status)
          ? { rowCount: 1, rows: [{ id: recoveryJobId, max_attempts: 3, bullmq_job_id: recovery.queued ? recoveryJobId : null }] }
          : { rowCount: 0, rows: [] };
      }
      if (query.includes('INSERT INTO knowledge_processing_jobs')) {
        recovery.inserted = true;
        recovery.insertCount += 1;
        return { rowCount: 1, rows: [{ id: recoveryJobId, max_attempts: 3, bullmq_job_id: null }] };
      }
      if (query.includes('UPDATE knowledge_processing_jobs')) {
        recovery.queued = true;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected runtime recovery query: ${query}`);
    },
  });

  await assert.rejects(
    loadPublishedEngineArtifacts({ tenantId }, { agentId, usageDirection: 'inbound' }, {
      cache,
      contextRunner: runtimeContextRunner,
      async enqueueProcessingJob({ processingJobId }) {
        assert.equal(String(processingJobId), recoveryJobId);
        return { id: processingJobId };
      },
    }),
    (error) => error?.code === 'KNOWLEDGE_PUBLICATION_ARTIFACT_MISSING'
      && error?.details?.recovery?.scheduled === true
      && error?.details?.recovery?.queued === true,
  );
  assert.equal(recovery.insertCount, 1);

  const versions = [{
    document_id: documentId,
    document_type: 'catalog',
    document_version_id: documentVersionId,
    b2_object_key: `tenant/${tenantId}/kb/${knowledgeBaseB}/original.txt`,
    extracted_text_object_key: `tenant/${tenantId}/kb/${knowledgeBaseB}/extracted.txt`,
    size_bytes: 100,
    parser_version: 1,
    document_contract_version: 1,
  }];
  const recoveryJob = {
    id: recoveryJobId,
    tenant_id: tenantId,
    knowledge_base_id: knowledgeBaseB,
    status: 'queued',
    knowledge_base_status: 'published',
    publication_revision: 8,
    pending_publication_revision: null,
    knowledge_base_usage: 'both',
    assigned_agent_ids: [agentId],
    attempt_count: 0,
    max_attempts: 3,
    metadata: { publicationRevision: 8, artifactRecovery: true },
  };
  const processingContextRunner = async (_auth, operation) => operation({
    async query(sql) {
      const query = String(sql);
      if (query.includes('SELECT tenant_id, knowledge_base_id FROM knowledge_processing_jobs')) {
        return { rowCount: 1, rows: [{ tenant_id: tenantId, knowledge_base_id: knowledgeBaseB }] };
      }
      if (query.includes('SELECT id FROM knowledge_bases')) return { rowCount: 1, rows: [{ id: knowledgeBaseB }] };
      if (query.includes('SELECT j.*, kb.status')) return { rowCount: 1, rows: [{ ...recoveryJob, status: recovery.status }] };
      if (query.includes("SET status = 'running'")) {
        recovery.status = 'running';
        return { rowCount: 1, rows: [] };
      }
      if (query.includes("'faq'::text AS record_type")) {
        return { rowCount: publishedB.records.length, rows: publishedB.records };
      }
      if (query.includes('SELECT d.id AS document_id')) return { rowCount: versions.length, rows: versions };
      if (query.includes('SELECT 1 FROM knowledge_bases')) return { rowCount: 1, rows: [{}] };
      if (query.includes("SET status='completed'")) {
        recovery.status = 'completed';
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  });
  const qdrantMutations = [];
  const recovered = await processSemanticIndexJob(recoveryJobId, {
    contextRunner: processingContextRunner,
    embed: async (texts) => texts.map(() => Array.from({ length: env.EMBEDDING_DIMENSIONS }, () => 0.01)),
    ensureCollection: async () => ({ created: false }),
    deleteKnowledgeBasePoints: async (_foundTenant, _foundKb, options) => {
      qdrantMutations.push(options.revisionMode);
      return { verified: true, remainingCount: 0 };
    },
    upsertPoints: async (_foundTenant, points) => ({ count: points.length }),
    countRevisionPoints: async () => ({ count: publishedB.records.length, verified: true }),
    verifyStorageObject: async () => ({ verified: true }),
    cacheKnowledgeMap: (job, records, bundle) => cacheCompactKnowledgeMap(job, records, cache, bundle),
    deleteKnowledgeArtifacts: async () => ({ verified: true }),
    invalidateCache: async () => ({ verified: true }),
  });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.artifactRecovery, true);
  assert.equal(recovery.status, 'completed');
  assert.equal(qdrantMutations.includes('equal'), false,
    'Healthy active-revision vectors must not be destructively rebuilt during Redis-only recovery');
  assert.equal(artifactKeys(knowledgeBaseB, 8).every((key) => cache.values.has(key)), true,
    'Recovery must restore all seven KB-B artifacts');

  const loaded = await loadPublishedEngineArtifacts(
    { tenantId }, { agentId, usageDirection: 'inbound' },
    { cache, contextRunner: runtimeContextRunner },
  );
  assert.equal(loaded.publications.length, 1);
  assert.equal(loaded.bundles[0].knowledgeBaseId, knowledgeBaseB);

  const readinessKey = artifactKeys(knowledgeBaseB, 8)[4];
  const readinessArtifact = cache.values.get(readinessKey);
  assert.ok(readinessArtifact);
  await cache.set(readinessKey, JSON.stringify({
    ...JSON.parse(readinessArtifact),
    version: publishedB.bundle.version - 1,
  }));
  let readinessClock = 0;
  let readinessWaits = 0;
  const ready = await ensurePublishedEngineReady(
    { tenantId }, { agentId, callId: `readiness-${pass}`, usageDirection: 'inbound' },
    {
      cache,
      contextRunner: runtimeContextRunner,
      readinessTimeoutMs: 1_000,
      readinessPollMs: 10,
      now: () => readinessClock,
      async wait(delayMs) {
        readinessClock += delayMs;
        readinessWaits += 1;
        await cache.set(readinessKey, readinessArtifact);
      },
      async enqueueProcessingJob({ processingJobId }) { return { id: processingJobId }; },
    },
  );
  assert.equal(readinessWaits, 1);
  assert.equal(ready.readiness.ready, true);
  assert.equal(ready.readiness.attempts, 2);
  assert.equal(ready.readiness.artifactCount, 7);
  return {
    pass, preservedArtifacts: 7, restoredArtifacts: 7,
    readinessAttempts: ready.readiness.attempts, recoveryJobs: recovery.insertCount,
  };
}

const passes = [];
for (let pass = 1; pass <= repeats; pass += 1) passes.push(await runPass(pass));
console.log(JSON.stringify({
  gate: 'knowledge-artifact-deletion-recovery',
  passed: true,
  repeats,
  passes,
}, null, 2));
