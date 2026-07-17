import assert from 'node:assert/strict';
import pg from 'pg';
import { env } from '../src/config/env.js';

const { Client } = pg;

const tables = [
  'knowledge_bases',
  'knowledge_documents',
  'knowledge_document_versions',
  'knowledge_processing_jobs',
  'faq_entries',
  'structured_catalogs',
  'structured_items',
  'structured_item_attributes',
  'workflow_rules',
  'conversation_flows',
  'knowledge_chunks',
  'agent_knowledge_bases',
];

const client = new Client({
  connectionString: env.DATABASE_URL,
  application_name: 'zea-voice-rag-task-2-verification',
});

async function insertTenant(label) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenant = await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ($1, $2, 'active')
     RETURNING id`,
    [`RAG verification ${label}`, `rag-verification-${label}-${suffix}`],
  );
  const tenantId = tenant.rows[0].id;

  const organization = await client.query(
    `INSERT INTO organizations (tenant_id, name, status)
     VALUES ($1, $2, 'active')
     RETURNING id`,
    [tenantId, `RAG verification ${label}`],
  );

  const workspace = await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1, $2, 'Default', 'default', 'active', true)
     RETURNING id`,
    [tenantId, organization.rows[0].id],
  );

  const knowledgeBase = await client.query(
    `INSERT INTO knowledge_bases (tenant_id, workspace_id, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [tenantId, workspace.rows[0].id, `Hospital KB ${label}`],
  );

  const document = await client.query(
    `INSERT INTO knowledge_documents (
       tenant_id, knowledge_base_id, document_type, display_name,
       original_filename, mime_type, size_bytes, status
     ) VALUES ($1, $2, 'general_knowledge', $3, $4, 'application/pdf', 1024, 'ready')
     RETURNING id`,
    [tenantId, knowledgeBase.rows[0].id, `Hospital guide ${label}`, `hospital-${label}.pdf`],
  );

  const version = await client.query(
    `INSERT INTO knowledge_document_versions (
       tenant_id, knowledge_base_id, document_id, version_number, status, is_current,
       b2_bucket, b2_object_key, content_sha256, size_bytes,
       embedding_model, embedding_dimensions, chunk_size_tokens, chunk_overlap_tokens
     ) VALUES ($1, $2, $3, 1, 'ready', true, 'zea-voice', $4, $5, 1024,
       'intfloat/multilingual-e5-small', 384, 400, 50)
     RETURNING id`,
    [
      tenantId,
      knowledgeBase.rows[0].id,
      document.rows[0].id,
      `verification/${tenantId}/${document.rows[0].id}/v1.pdf`,
      label === 'a' ? 'a'.repeat(64) : 'b'.repeat(64),
    ],
  );

  return {
    tenantId,
    workspaceId: workspace.rows[0].id,
    knowledgeBaseId: knowledgeBase.rows[0].id,
    documentId: document.rows[0].id,
    versionId: version.rows[0].id,
  };
}

async function addTenantAChildren(fixture) {
  const values = [fixture.tenantId, fixture.knowledgeBaseId, fixture.documentId, fixture.versionId];

  await client.query(
    `INSERT INTO faq_entries (
       tenant_id, knowledge_base_id, document_id, document_version_id, question, answer
     ) VALUES ($1, $2, $3, $4, 'Where is the hospital?', 'The hospital is in Salem.')`,
    values,
  );

  const catalog = await client.query(
    `INSERT INTO structured_catalogs (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       catalog_type, name, default_currency
     ) VALUES ($1, $2, $3, $4, 'packages', 'Health packages', 'INR')
     RETURNING id`,
    values,
  );

  const item = await client.query(
    `INSERT INTO structured_items (
       tenant_id, knowledge_base_id, catalog_id, document_id, document_version_id,
       item_key, name, price, currency
     ) VALUES ($1, $2, $5, $3, $4, 'silver', 'Silver Package', 1650, 'INR')
     RETURNING id`,
    [...values, catalog.rows[0].id],
  );

  await client.query(
    `INSERT INTO structured_item_attributes (
       tenant_id, knowledge_base_id, item_id, document_id, document_version_id,
       attribute_key, display_name, value
     ) VALUES ($1, $2, $5, $3, $4, 'tests', 'Included tests', $6::jsonb)`,
    [...values, item.rows[0].id, JSON.stringify(['CBC', 'ECG'])],
  );

  await client.query(
    `INSERT INTO workflow_rules (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       name, intent, action_type, action_config
     ) VALUES ($1, $2, $3, $4, 'Doctor advice', 'doctor_advice', 'transfer_call', $5::jsonb)`,
    [...values, JSON.stringify({ queue: 'clinical-support' })],
  );

  await client.query(
    `INSERT INTO conversation_flows (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       flow_key, node_key, is_entry, content, variables, transitions
     ) VALUES ($1, $2, $3, $4, 'main', 'introduction', true,
       'Good morning, I am your hospital voice assistant.', $5::jsonb, '[]'::jsonb)`,
    [...values, JSON.stringify(['company_name', 'agent_name'])],
  );

  await client.query(
    `INSERT INTO knowledge_chunks (
       tenant_id, knowledge_base_id, document_id, document_version_id,
       chunk_index, content, token_count
     ) VALUES ($1, $2, $3, $4, 0, 'A cardiac check-up helps assess heart health.', 10)`,
    values,
  );

  await client.query(
    `INSERT INTO knowledge_processing_jobs (
       tenant_id, knowledge_base_id, document_id, document_version_id, job_type
     ) VALUES ($1, $2, $3, $4, 'index')`,
    values,
  );
}

async function verifySchema() {
  const result = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [tables],
  );
  assert.equal(result.rowCount, tables.length, 'Not all Task 2 tables exist');
  for (const row of result.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} must have RLS enabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
  }

  const privileges = await client.query(
    `SELECT table_name,
            has_table_privilege('zea_voice_runtime', format('public.%I', table_name), 'SELECT') AS can_select,
            has_table_privilege('zea_voice_runtime', format('public.%I', table_name), 'INSERT') AS can_insert,
            has_table_privilege('zea_voice_runtime', format('public.%I', table_name), 'UPDATE') AS can_update,
            has_table_privilege('zea_voice_runtime', format('public.%I', table_name), 'DELETE') AS can_delete
       FROM unnest($1::text[]) AS table_name`,
    [tables],
  );
  for (const row of privileges.rows) {
    assert.ok(row.can_select && row.can_insert && row.can_update && row.can_delete,
      `zea_voice_runtime is missing CRUD privileges on ${row.table_name}`);
  }
}

async function verifyTenantForeignKeys(tenantA, tenantB) {
  await client.query('SAVEPOINT tenant_fk_check');
  try {
    await client.query(
      `INSERT INTO knowledge_documents (
         tenant_id, knowledge_base_id, document_type, display_name,
         original_filename, mime_type, size_bytes
       ) VALUES ($1, $2, 'faq', 'Cross tenant', 'cross-tenant.pdf', 'application/pdf', 100)`,
      [tenantB.tenantId, tenantA.knowledgeBaseId],
    );
    assert.fail('Cross-tenant document insertion unexpectedly succeeded');
  } catch (error) {
    assert.equal(error.code, '23503', 'Cross-tenant insertion must fail through a composite foreign key');
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT tenant_fk_check');
    await client.query('RELEASE SAVEPOINT tenant_fk_check');
  }
}

async function verifyRuntimeRls(tenantA, tenantB) {
  await client.query('SET LOCAL ROLE zea_voice_runtime');
  await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA.tenantId]);
  const visibleToA = await client.query('SELECT tenant_id FROM knowledge_bases ORDER BY tenant_id');
  assert.deepEqual([...new Set(visibleToA.rows.map((row) => row.tenant_id))], [tenantA.tenantId]);

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantB.tenantId]);
  const visibleToB = await client.query('SELECT tenant_id FROM knowledge_bases ORDER BY tenant_id');
  assert.deepEqual([...new Set(visibleToB.rows.map((row) => row.tenant_id))], [tenantB.tenantId]);

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA.tenantId]);
  const deleted = await client.query('DELETE FROM knowledge_bases WHERE id = $1 RETURNING id', [tenantA.knowledgeBaseId]);
  assert.equal(deleted.rowCount, 1, 'Tenant A must be allowed to delete its own knowledge base');

  const childCounts = await client.query(
    `SELECT
       (SELECT count(*)::int FROM knowledge_documents WHERE knowledge_base_id = $1) AS documents,
       (SELECT count(*)::int FROM knowledge_document_versions WHERE knowledge_base_id = $1) AS versions,
       (SELECT count(*)::int FROM faq_entries WHERE knowledge_base_id = $1) AS faqs,
       (SELECT count(*)::int FROM structured_catalogs WHERE knowledge_base_id = $1) AS catalogs,
       (SELECT count(*)::int FROM structured_items WHERE knowledge_base_id = $1) AS items,
       (SELECT count(*)::int FROM structured_item_attributes WHERE knowledge_base_id = $1) AS attributes,
       (SELECT count(*)::int FROM workflow_rules WHERE knowledge_base_id = $1) AS workflows,
       (SELECT count(*)::int FROM conversation_flows WHERE knowledge_base_id = $1) AS flows,
       (SELECT count(*)::int FROM knowledge_chunks WHERE knowledge_base_id = $1) AS chunks,
       (SELECT count(*)::int FROM knowledge_processing_jobs WHERE knowledge_base_id = $1) AS jobs`,
    [tenantA.knowledgeBaseId],
  );
  assert.ok(Object.values(childCounts.rows[0]).every((count) => count === 0),
    'Deleting a knowledge base must cascade to every owned record');

  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantB.tenantId]);
  const tenantBStillExists = await client.query('SELECT id FROM knowledge_bases WHERE id = $1', [tenantB.knowledgeBaseId]);
  assert.equal(tenantBStillExists.rowCount, 1, 'Deleting Tenant A data must not affect Tenant B');
  await client.query('RESET ROLE');
}

let transactionStarted = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");

  await verifySchema();
  const tenantA = await insertTenant('a');
  const tenantB = await insertTenant('b');
  await addTenantAChildren(tenantA);
  await verifyTenantForeignKeys(tenantA, tenantB);
  await verifyRuntimeRls(tenantA, tenantB);

  console.log(JSON.stringify({
    ok: true,
    task: 'RAG Task 2 - Knowledge Base database structure',
    verified: {
      tables: tables.length,
      rlsEnabledAndForced: true,
      runtimeCrudGranted: true,
      compositeTenantForeignKeys: true,
      runtimeTenantVisibility: true,
      knowledgeBaseCascadeDelete: true,
    },
    fixturesPersisted: false,
  }, null, 2));
} finally {
  if (transactionStarted) {
    try {
      await client.query('RESET ROLE');
    } catch {
      // The transaction can already be aborted; rollback below is still safe.
    }
    await client.query('ROLLBACK');
  }
  await client.end();
}
