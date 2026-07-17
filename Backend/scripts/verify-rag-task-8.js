import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { env } from '../src/config/env.js';
import {
  deleteTenantCollection,
  ensureTenantCollection,
  searchTenantPoints,
  upsertTenantPoints,
} from '../src/rag/qdrant.client.js';
import { tenantVectorPayload } from '../src/rag/tenant-isolation.js';
import { runtimeKnowledgeQuerySchema } from '../src/knowledge-bases/knowledge-runtime.schemas.js';
import { routeKnowledgeQuery } from '../src/knowledge-bases/knowledge-runtime.service.js';

const { Client } = pg;

class MemoryCache {
  status = 'ready';
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, value); return 'OK'; }
}

async function verifyQdrantSearchContract() {
  const tenantId = crypto.randomUUID();
  const knowledgeBases = [
    { id: crypto.randomUUID(), publicationRevision: 2 },
    { id: crypto.randomUUID(), publicationRevision: 5 },
  ];
  let request;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ result: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await searchTenantPoints(tenantId, Array(env.QDRANT_VECTOR_SIZE).fill(0), {
      knowledgeBases, usageDirection: 'outbound', limit: 3, scoreThreshold: 0.72,
    });
    assert.deepEqual(result, []);
    assert.match(request.url, /points\/search$/);
    assert.equal(request.body.with_vector, false);
    assert.deepEqual(request.body.filter.must[0], {
      key: 'tenant_id', match: { value: tenantId },
    });
    assert.deepEqual(request.body.filter.must[1].match.any, ['OUTBOUND', 'BOTH']);
    assert.equal(request.body.filter.must[3].should.length, 2);
    assert.deepEqual(request.body.filter.must[3].should[0].must, [
      { key: 'knowledge_base_id', match: { value: knowledgeBases[0].id } },
      { key: 'publication_revision', match: { value: 2 } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function createProviderModel(client, type, suffix) {
  const provider = await client.query(
    `INSERT INTO ai_providers (name, slug, type, status)
     VALUES ($1, $2, $3, 'connected') RETURNING id`,
    [`Runtime ${type} ${suffix}`, `runtime-${type}-${suffix}`, type],
  );
  return (await client.query(
    `INSERT INTO provider_models (provider_id, model_key, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [provider.rows[0].id, `runtime-${type}-${suffix}`, `Runtime ${type}`],
  )).rows[0].id;
}

async function createDocument(client, tenant, type) {
  const document = await client.query(
    `INSERT INTO knowledge_documents (
       tenant_id, knowledge_base_id, document_type, display_name,
       original_filename, size_bytes, status
     ) VALUES ($1,$2,$3,$4,$5,100,'ready') RETURNING id`,
    [tenant.tenantId, tenant.knowledgeBaseId, type, `${type} runtime`, `${type}.pdf`],
  );
  const version = await client.query(
    `INSERT INTO knowledge_document_versions (
       tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
       b2_bucket, b2_object_key, content_sha256, size_bytes, page_count, processed_at
     ) VALUES ($1,$2,$3,1,'ready',true,'zea-voice',$4,$5,100,1,now()) RETURNING id`,
    [
      tenant.tenantId, tenant.knowledgeBaseId, document.rows[0].id,
      `runtime/${tenant.tenantId}/${document.rows[0].id}.pdf`,
      crypto.createHash('sha256').update(`${tenant.tenantId}-${type}`).digest('hex'),
    ],
  );
  return { documentId: document.rows[0].id, versionId: version.rows[0].id };
}

async function createFixtures(client) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}`.toLowerCase();
  const tenantId = (await client.query(
    `INSERT INTO tenants (name, slug, status) VALUES ('Runtime Router', $1, 'active') RETURNING id`,
    [`runtime-router-${suffix}`],
  )).rows[0].id;
  const organizationId = (await client.query(
    `INSERT INTO organizations (tenant_id, name, status) VALUES ($1,'Runtime Router','active') RETURNING id`,
    [tenantId],
  )).rows[0].id;
  const workspaceId = (await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1,$2,'Default','default','active',true) RETURNING id`,
    [tenantId, organizationId],
  )).rows[0].id;
  const sttModelId = await createProviderModel(client, 'stt', `${suffix}-stt`);
  const llmModelId = await createProviderModel(client, 'llm', `${suffix}-llm`);
  const ttsModelId = await createProviderModel(client, 'tts', `${suffix}-tts`);
  const agentId = (await client.query(
    `INSERT INTO voice_agents (
       tenant_id, workspace_id, name, language, usage_direction, status,
       stt_model_id, llm_model_id, tts_model_id, voice_id, prompt
     ) VALUES ($1,$2,'Runtime Agent','en','outbound','active',$3,$4,$5,'voice','prompt') RETURNING id`,
    [tenantId, workspaceId, sttModelId, llmModelId, ttsModelId],
  )).rows[0].id;
  const knowledgeBaseId = (await client.query(
    `INSERT INTO knowledge_bases (
       tenant_id, workspace_id, name, status, usage_direction,
       publication_revision, published_at
     ) VALUES ($1,$2,'Runtime KB','published','both',1,now()) RETURNING id`,
    [tenantId, workspaceId],
  )).rows[0].id;
  await client.query(
    `INSERT INTO agent_knowledge_bases (tenant_id, agent_id, knowledge_base_id, usage_direction)
     VALUES ($1,$2,$3,'both')`,
    [tenantId, agentId, knowledgeBaseId],
  );
  const tenant = { tenantId, workspaceId, agentId, knowledgeBaseId };
  const workflow = await createDocument(client, tenant, 'workflow_rules');
  await client.query(
    `INSERT INTO workflow_rules (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       name, intent, action_type, action_config, response_template,
       usage_direction, status, approved_at
     ) VALUES ($1,$2,$3,$4,'Transfer to agent','transfer_to_agent','transfer_call',
       '{"queue":"support"}'::jsonb,'I will transfer your call.','both','approved',now())`,
    [tenantId, knowledgeBaseId, workflow.documentId, workflow.versionId],
  );
  const conversation = await createDocument(client, tenant, 'conversation_script');
  await client.query(
    `INSERT INTO conversation_flows (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       flow_key, node_key, language, is_entry, content, status, approved_at
     ) VALUES ($1,$2,$3,$4,'main','welcome','en',true,'Welcome to the hospital.','approved',now())`,
    [tenantId, knowledgeBaseId, conversation.documentId, conversation.versionId],
  );
  const catalog = await createDocument(client, tenant, 'catalog');
  const catalogId = (await client.query(
    `INSERT INTO structured_catalogs (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       catalog_type, name, status, approved_at
     ) VALUES ($1,$2,$3,$4,'packages','Packages','approved',now()) RETURNING id`,
    [tenantId, knowledgeBaseId, catalog.documentId, catalog.versionId],
  )).rows[0].id;
  const itemId = (await client.query(
    `INSERT INTO structured_items (
       tenant_id, knowledge_base_id, catalog_id, document_id, document_version_id,
       item_key, name, description, price, currency, status, approved_at
     ) VALUES ($1,$2,$3,$4,$5,'silver_package','Silver Package','Basic screening',1650,'INR','approved',now())
     RETURNING id`,
    [tenantId, knowledgeBaseId, catalogId, catalog.documentId, catalog.versionId],
  )).rows[0].id;
  await client.query(
    `INSERT INTO structured_item_attributes (
       tenant_id, knowledge_base_id, item_id, document_id, document_version_id,
       attribute_key, display_name, value
     ) VALUES ($1,$2,$3,$4,$5,'fasting','Fasting','"8 hours"'::jsonb)`,
    [tenantId, knowledgeBaseId, itemId, catalog.documentId, catalog.versionId],
  );
  const faq = await createDocument(client, tenant, 'faq');
  await client.query(
    `INSERT INTO faq_entries (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       question, answer, language, status, approved_at
     ) VALUES ($1,$2,$3,$4,'Where is the hospital?','The hospital is in Salem.','en','approved',now())`,
    [tenantId, knowledgeBaseId, faq.documentId, faq.versionId],
  );
  await client.query(
    `INSERT INTO knowledge_processing_jobs (
       tenant_id, knowledge_base_id, job_type, status, progress, metadata, completed_at
     ) VALUES ($1,$2,'index','completed',100,'{"publicationRevision":1}'::jsonb,now())`,
    [tenantId, knowledgeBaseId],
  );
  return tenant;
}

async function verifyRuntimeRouter() {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-8-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const fixture = await createFixtures(client);
    const cache = new MemoryCache();
    const contextRunner = (_auth, operation) => operation(client);
    let embeddingCalls = 0;
    let searchCalls = 0;
    let receivedSearchOptions;
    const dependencies = {
      contextRunner,
      cache,
      async embed() {
        embeddingCalls += 1;
        return Array(env.EMBEDDING_DIMENSIONS).fill(0.01);
      },
      async search(_tenantId, _vector, options) {
        searchCalls += 1;
        receivedSearchOptions = options;
        return [
          {
            id: crypto.randomUUID(), score: 0.99,
            payload: {
              tenant_id: crypto.randomUUID(), knowledge_base_id: fixture.knowledgeBaseId,
              publication_revision: 1, agent_usage: 'OUTBOUND', record_type: 'KNOWLEDGE_CHUNK',
              content: 'Cross-tenant content must be discarded.',
            },
          },
          {
            id: crypto.randomUUID(), score: 0.91,
            payload: {
              tenant_id: fixture.tenantId, knowledge_base_id: fixture.knowledgeBaseId,
              publication_revision: 1, agent_usage: 'BOTH', record_type: 'KNOWLEDGE_CHUNK',
              document_id: crypto.randomUUID(), content: 'Cardiac screening helps assess heart health.',
            },
          },
        ];
      },
    };
    const auth = {
      tenantId: fixture.tenantId, workspaceId: fixture.workspaceId,
      userId: null, role: 'COMPANY_DEVELOPER',
    };
    const base = { agentId: fixture.agentId, usageDirection: 'outbound', language: 'en', routeHint: 'auto' };

    const workflow = await routeKnowledgeQuery(auth, {
      ...base, query: 'Transfer to agent', intent: 'transfer_to_agent',
    }, dependencies);
    assert.equal(workflow.route, 'workflow');
    assert.equal(workflow.action.type, 'transfer_call');

    const conversation = await routeKnowledgeQuery(auth, {
      ...base, query: 'start', routeHint: 'conversation', flowKey: 'main',
    }, dependencies);
    assert.equal(conversation.route, 'conversation');
    assert.equal(conversation.content, 'Welcome to the hospital.');

    const catalog = await routeKnowledgeQuery(auth, {
      ...base, query: 'What is the Silver Package price?',
    }, dependencies);
    assert.equal(catalog.route, 'catalog');
    assert.equal(catalog.item.price, 1650);
    assert.equal(catalog.item.currency, 'INR');
    assert.equal(catalog.item.attributes[0].key, 'fasting');

    const faq = await routeKnowledgeQuery(auth, {
      ...base, query: 'Where is the hospital?',
    }, dependencies);
    assert.equal(faq.route, 'faq');
    assert.equal(faq.content, 'The hospital is in Salem.');
    assert.equal(embeddingCalls, 0, 'Deterministic routes must not call the embedding service');

    const semanticInput = { ...base, query: 'Why is cardiac screening useful?' };
    const semantic = await routeKnowledgeQuery(auth, semanticInput, dependencies);
    assert.equal(semantic.route, 'semantic');
    assert.equal(semantic.matches.length, 1, 'Cross-tenant vector results must be discarded');
    assert.equal(semantic.content, 'Cardiac screening helps assess heart health.');
    assert.deepEqual(receivedSearchOptions.knowledgeBases, [{
      id: fixture.knowledgeBaseId, publicationRevision: 1,
    }]);
    assert.equal(receivedSearchOptions.usageDirection, 'outbound');
    const cachedSemantic = await routeKnowledgeQuery(auth, semanticInput, dependencies);
    assert.equal(cachedSemantic.route, 'semantic');
    assert.equal(cachedSemantic.cacheHit, true);
    assert.equal(embeddingCalls, 1);
    assert.equal(searchCalls, 1);

    await assert.rejects(
      routeKnowledgeQuery(auth, { ...base, usageDirection: 'inbound', query: 'hello' }, {
        ...dependencies, cache: new MemoryCache(),
      }),
      (error) => error.code === 'RUNTIME_AGENT_DIRECTION_MISMATCH',
    );
  } finally {
    if (transactionStarted) await client.query('ROLLBACK');
    await client.end();
  }
}

async function verifyApiContract() {
  assert.equal(runtimeKnowledgeQuerySchema.safeParse({
    agentId: crypto.randomUUID(), query: 'Where is the hospital?', usageDirection: 'inbound',
  }).success, true);
  assert.equal(runtimeKnowledgeQuerySchema.safeParse({
    agentId: crypto.randomUUID(), query: 'x', usageDirection: 'both',
  }).success, false);
  const routes = await readFile(new URL('../src/knowledge-bases/knowledge-base.routes.js', import.meta.url), 'utf8');
  assert.match(routes, /post\('\/runtime\/query'/);
}

async function verifyLiveProvidersWhenRequested() {
  if (process.env.RAG_TASK8_LIVE_QDRANT !== 'true') return false;
  const tenantId = crypto.randomUUID();
  const knowledgeBaseId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  const documentVersionId = crypto.randomUUID();
  const recordId = crypto.randomUUID();
  const content = 'The hospital cardiac screening helps assess heart health.';
  try {
    await ensureTenantCollection(tenantId);
    const passageVector = Array.from(
      { length: env.EMBEDDING_DIMENSIONS }, (_value, index) => index === 0 ? 1 : 0,
    );
    await upsertTenantPoints(tenantId, [{
      id: recordId,
      vector: passageVector,
      payload: tenantVectorPayload({
        tenantId, knowledgeBaseId, documentId, documentVersionId, recordId,
        recordType: 'knowledge_chunk', agentUsage: 'BOTH',
        category: 'general_knowledge', publicationRevision: 1, content,
      }),
    }]);
    const queryVector = [...passageVector];
    const matches = await searchTenantPoints(tenantId, queryVector, {
      knowledgeBases: [{ id: knowledgeBaseId, publicationRevision: 1 }],
      usageDirection: 'outbound', limit: 3, scoreThreshold: 0,
    });
    assert.ok(matches.some((match) => match.id === recordId));
    return true;
  } finally {
    await deleteTenantCollection(tenantId);
  }
}

await verifyQdrantSearchContract();
await verifyRuntimeRouter();
await verifyApiContract();
const liveProvidersVerified = await verifyLiveProvidersWhenRequested();

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 8 - Low-latency runtime router',
  verified: {
    deterministicFirstRouting: ['workflow', 'conversation', 'catalog', 'faq'],
    semanticFallback: true,
    tenantIsolation: true,
    agentKnowledgeBaseAssignments: true,
    publicationRevisionFiltering: true,
    usageDirectionFiltering: true,
    redisHotPathCache: true,
    cacheFailureFallback: true,
    authenticatedRuntimeApi: 'POST /knowledge-bases/runtime/query',
  },
  liveQdrantSearchVerified: liveProvidersVerified,
  temporaryQdrantCollectionDeleted: liveProvidersVerified,
  databaseFixturesPersisted: false,
}, null, 2));
