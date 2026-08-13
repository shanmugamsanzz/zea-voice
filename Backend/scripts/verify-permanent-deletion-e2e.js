import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { processKnowledgeDeletionJob } from '../src/knowledge-bases/knowledge-deletion.service.js';
import { routeKnowledgeQuery } from '../src/knowledge-bases/knowledge-runtime.service.js';

const documentTypes = [
  'faq', 'catalog', 'workflow_rules', 'conversation_script', 'general_knowledge',
];
const postgresDocumentTables = [
  'knowledge_documents', 'knowledge_document_versions', 'knowledge_processing_jobs',
  'faq_entries', 'structured_catalogs', 'structured_items', 'structured_item_attributes',
  'workflow_rules', 'conversation_flows', 'knowledge_chunks',
];
const postgresKnowledgeBaseTables = [
  'knowledge_bases', ...postgresDocumentTables, 'agent_knowledge_bases',
];

const documentConstraints = [
  ['knowledge_document_versions', 'knowledge_documents'],
  ['knowledge_processing_jobs', 'knowledge_documents'],
  ['faq_entries', 'knowledge_document_versions'],
  ['structured_catalogs', 'knowledge_document_versions'],
  ['structured_items', 'structured_catalogs'],
  ['structured_item_attributes', 'structured_items'],
  ['workflow_rules', 'knowledge_document_versions'],
  ['conversation_flows', 'knowledge_document_versions'],
  ['knowledge_chunks', 'knowledge_document_versions'],
];
const knowledgeBaseConstraints = [
  ['knowledge_documents', 'knowledge_bases'],
  ...documentConstraints,
  ['agent_knowledge_bases', 'knowledge_bases'],
];

function constraintRows(values) {
  return values.map(([child_table, parent_table], index) => ({
    child_table,
    parent_table,
    constraint_name: `permanent_delete_cascade_${index}`,
    delete_action: 'c',
  }));
}

function recordCounts(type, documentCount = 1) {
  const counts = new Map(postgresKnowledgeBaseTables.map((table) => [table, 0]));
  counts.set('knowledge_bases', 1);
  counts.set('knowledge_documents', documentCount);
  counts.set('knowledge_document_versions', documentCount);
  counts.set('knowledge_processing_jobs', documentCount + 1);
  if (type === 'faq' || type === 'complete_kb') counts.set('faq_entries', 1);
  if (type === 'catalog' || type === 'complete_kb') {
    counts.set('structured_catalogs', 1);
    counts.set('structured_items', 1);
    counts.set('structured_item_attributes', 1);
  }
  if (type === 'workflow_rules' || type === 'complete_kb') counts.set('workflow_rules', 1);
  if (type === 'conversation_script' || type === 'complete_kb') counts.set('conversation_flows', 1);
  if (type === 'general_knowledge' || type === 'complete_kb') counts.set('knowledge_chunks', 1);
  if (type === 'complete_kb') counts.set('agent_knowledge_bases', 1);
  return counts;
}

class NullRuntimeCache {
  status = 'ready';
  async get() { return null; }
  async set() { return 'OK'; }
}

function createScenario(type, { completeKnowledgeBase = false } = {}) {
  const tenantId = crypto.randomUUID();
  const knowledgeBaseId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const documentIds = completeKnowledgeBase
    ? documentTypes.map(() => crypto.randomUUID())
    : [crypto.randomUUID()];
  const selectedDocumentId = documentIds[0];
  const token = `deleted-${type}-${crypto.randomUUID()}`;
  const job = {
    id: jobId,
    tenant_id: tenantId,
    knowledge_base_id: knowledgeBaseId,
    document_id: completeKnowledgeBase ? null : selectedDocumentId,
    job_type: completeKnowledgeBase ? 'delete_knowledge_base' : 'delete_document',
    status: 'queued',
    attempt_count: 0,
    max_attempts: 10,
    metadata: completeKnowledgeBase ? { assignedAgentIds: [agentId] } : {},
  };
  const counts = recordCounts(type, documentIds.length);
  const versionRows = documentIds.map((documentId) => ({
    id: crypto.randomUUID(),
    document_id: documentId,
    b2_object_key: `tenants/${tenantId}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/versions/1/source.pdf`,
    extracted_text_object_key: `tenants/${tenantId}/knowledge-bases/${knowledgeBaseId}/documents/${documentId}/versions/1/extracted-text.json`,
  }));
  const relatedDbJobId = crypto.randomUUID();
  const relatedBullJobId = `bull-${crypto.randomUUID()}`;
  const stores = {
    postgres: counts,
    qdrant: new Set(documentIds.map((documentId) => `${documentId}:${token}`)),
    b2: new Set(versionRows.flatMap((version) => [
      `${version.b2_object_key}:source-version`,
      `${version.extracted_text_object_key}:text-version`,
      `${version.b2_object_key}:delete-marker`,
    ])),
    redis: new Set([
      `zea:rag:profile:${tenantId}:${agentId}:inbound:en`,
      `zea:rag:result:${tenantId}:${agentId}:inbound:${token}`,
      `zea:rag:entity:${tenantId}:${agentId}:inbound:${token}`,
    ]),
    bullmq: new Set([relatedDbJobId, relatedBullJobId]),
  };
  let hardDeleted = false;

  const profile = () => ({
    agent_usage: 'both',
    agent_settings: {},
    knowledge_bases: hardDeleted && completeKnowledgeBase ? [] : [{
      id: knowledgeBaseId, publicationRevision: 1, priority: 100, semanticReady: true,
    }],
    workflows: [],
    conversations: [],
    catalog_items: [],
    faqs: [],
  });

  const client = {
    async query(sql, values = []) {
      const text = String(sql).replace(/\s+/gu, ' ').trim();
      if (text.startsWith('WITH runtime_agent AS')) return { rowCount: 1, rows: [profile()] };
      if (text.includes('SELECT * FROM knowledge_processing_jobs')) {
        return hardDeleted ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ ...job }] };
      }
      if (text.startsWith('SELECT id FROM call_sessions')) return { rowCount: 0, rows: [] };
      if (text.includes('SELECT id, b2_object_key, extracted_text_object_key')) {
        const scoped = completeKnowledgeBase
          ? versionRows
          : versionRows.filter((version) => version.document_id === selectedDocumentId);
        return { rowCount: scoped.length, rows: scoped };
      }
      if (text.startsWith('SELECT id, bullmq_job_id')) {
        return { rowCount: 1, rows: [{ id: relatedDbJobId, bullmq_job_id: relatedBullJobId }] };
      }
      if (text.includes('FROM pg_constraint constraint_record')) {
        const rows = constraintRows(completeKnowledgeBase ? knowledgeBaseConstraints : documentConstraints);
        assert.deepEqual(values[0], completeKnowledgeBase ? postgresKnowledgeBaseTables : postgresDocumentTables);
        return { rowCount: rows.length, rows };
      }
      if (text.startsWith('DELETE FROM knowledge_documents')) {
        for (const table of postgresDocumentTables) counts.set(table, 0);
        hardDeleted = true;
        return { rowCount: 1, rows: [{ id: selectedDocumentId }] };
      }
      if (text.startsWith('DELETE FROM knowledge_bases')) {
        for (const table of postgresKnowledgeBaseTables) counts.set(table, 0);
        hardDeleted = true;
        return { rowCount: 1, rows: [{ id: knowledgeBaseId }] };
      }
      if (text.includes(') document_cascade_verification')) {
        const rows = postgresDocumentTables.map((table_name) => ({
          table_name, remaining_count: counts.get(table_name) ?? 0,
        }));
        return { rowCount: rows.length, rows };
      }
      if (text.includes(') cascade_verification')) {
        const rows = postgresKnowledgeBaseTables.map((table_name) => ({
          table_name, remaining_count: counts.get(table_name) ?? 0,
        }));
        return { rowCount: rows.length, rows };
      }
      if (text.startsWith('UPDATE call_transcript_entries transcript')) return { rowCount: 0, rows: [] };
      if (text.startsWith('DELETE FROM audit_logs audit')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };

  const contextRunner = async (_auth, operation) => operation(client);
  const dependencies = {
    contextRunner,
    async removeQueueJobs(ids) {
      for (const id of ids) stores.bullmq.delete(String(id));
      return { removed: ids, active: [], missing: [], verified: true, remaining: [] };
    },
    async deleteDocumentPoints(foundTenantId, documentId, options) {
      assert.equal(foundTenantId, tenantId);
      assert.equal(options.knowledgeBaseId, knowledgeBaseId);
      for (const point of [...stores.qdrant]) {
        if (point.startsWith(`${documentId}:`)) stores.qdrant.delete(point);
      }
      return { deleted: true, verified: true, remainingCount: stores.qdrant.size };
    },
    async deleteKnowledgeBasePoints(foundTenantId, foundKnowledgeBaseId) {
      assert.equal(foundTenantId, tenantId);
      assert.equal(foundKnowledgeBaseId, knowledgeBaseId);
      stores.qdrant.clear();
      return { deleted: true, verified: true, remainingCount: 0 };
    },
    storage: {
      async deleteDocumentPrefix({ tenantId: foundTenantId, knowledgeBaseId: foundKnowledgeBaseId, documentId }) {
        assert.equal(foundTenantId, tenantId);
        assert.equal(foundKnowledgeBaseId, knowledgeBaseId);
        for (const object of [...stores.b2]) {
          if (object.includes(`/documents/${documentId}/`)) stores.b2.delete(object);
        }
        return { deleted: true, verified: true, remainingObjectVersions: stores.b2.size };
      },
      async deletePrefix({ tenantId: foundTenantId, knowledgeBaseId: foundKnowledgeBaseId }) {
        assert.equal(foundTenantId, tenantId);
        assert.equal(foundKnowledgeBaseId, knowledgeBaseId);
        stores.b2.clear();
        return { deleted: true, verified: true, remainingObjectVersions: 0 };
      },
    },
    async invalidateCache(foundTenantId) {
      assert.equal(foundTenantId, tenantId);
      stores.redis.clear();
      return { deletedKeys: 3, verified: true, remainingKeys: 0 };
    },
    async queue() { throw new Error('A reindex job is not expected in this isolated deletion fixture'); },
  };
  return {
    type, token, tenantId, knowledgeBaseId, agentId, jobId, stores, counts,
    contextRunner, dependencies,
  };
}

async function assertRuntimeCannotRetrieveDeletedContent(scenario) {
  const result = await routeKnowledgeQuery({
    tenantId: scenario.tenantId,
    workspaceId: null,
    userId: null,
    role: 'COMPANY_DEVELOPER',
  }, {
    agentId: scenario.agentId,
    query: scenario.token,
    usageDirection: 'inbound',
    language: 'en',
    routeHint: 'auto',
  }, {
    contextRunner: scenario.contextRunner,
    cache: new NullRuntimeCache(),
    async embed() { return Array(384).fill(0); },
    async search() {
      return [...scenario.stores.qdrant].map((point) => ({
        id: crypto.randomUUID(),
        score: 1,
        payload: { content: point, tenant_id: scenario.tenantId },
      }));
    },
  });
  assert.equal(result.found, false, `${scenario.type}: runtime retrieval must not find deleted content`);
  assert.equal(result.content, null, `${scenario.type}: runtime content must be empty after deletion`);
  assert.equal(JSON.stringify(result).includes(scenario.token), false);
}

function assertEveryStoreIsZero(scenario, tables) {
  for (const table of tables) {
    assert.equal(scenario.counts.get(table) ?? 0, 0, `${scenario.type}: ${table} must contain zero rows`);
  }
  assert.equal(scenario.stores.qdrant.size, 0, `${scenario.type}: Qdrant must contain zero points`);
  assert.equal(scenario.stores.b2.size, 0, `${scenario.type}: B2 must contain zero object versions`);
  assert.equal(scenario.stores.redis.size, 0, `${scenario.type}: Redis must contain zero RAG keys`);
  assert.equal(scenario.stores.bullmq.size, 0, `${scenario.type}: BullMQ must contain zero related jobs`);
}

const reports = [];
for (const documentType of documentTypes) {
  const scenario = createScenario(documentType);
  const result = await processKnowledgeDeletionJob(scenario.jobId, scenario.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.permanentlyDeleted, true);
  assert.deepEqual(result.verification, {
    postgresRows: 0,
    b2ObjectVersions: 0,
    qdrantPoints: 0,
    redisRagKeys: 0,
    bullmqJobs: 0,
  });
  assertEveryStoreIsZero(scenario, postgresDocumentTables);
  await assertRuntimeCannotRetrieveDeletedContent(scenario);
  reports.push({ target: documentType, postgres: 0, qdrant: 0, b2: 0, redis: 0, bullmq: 0, runtimeFound: false });
}

const wholeKnowledgeBase = createScenario('complete_kb', { completeKnowledgeBase: true });
const knowledgeBaseResult = await processKnowledgeDeletionJob(
  wholeKnowledgeBase.jobId, wholeKnowledgeBase.dependencies,
);
assert.equal(knowledgeBaseResult.status, 'completed');
assert.equal(knowledgeBaseResult.permanentlyDeleted, true);
assert.deepEqual(knowledgeBaseResult.verification, {
  postgresRows: 0,
  agentAssignments: 0,
  b2ObjectVersions: 0,
  qdrantPoints: 0,
  redisRagKeys: 0,
  bullmqJobs: 0,
});
assertEveryStoreIsZero(wholeKnowledgeBase, postgresKnowledgeBaseTables);
await assertRuntimeCannotRetrieveDeletedContent(wholeKnowledgeBase);
reports.push({ target: 'complete_kb', postgres: 0, qdrant: 0, b2: 0, redis: 0, bullmq: 0, runtimeFound: false });

console.log(JSON.stringify({
  task: 'End-to-end permanent Knowledge deletion verification',
  passed: true,
  documentTypes,
  reports,
}, null, 2));
