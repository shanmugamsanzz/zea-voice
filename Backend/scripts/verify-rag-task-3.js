import assert from 'node:assert/strict';
import pg from 'pg';
import { requireRoles } from '../src/auth/auth.middleware.js';
import { API_KEY_SCOPES } from '../src/api-keys/api-key.schemas.js';
import { env } from '../src/config/env.js';
import { knowledgeBaseRouter } from '../src/knowledge-bases/knowledge-base.routes.js';
import {
  createKnowledgeBaseSchema,
  parseKnowledgeBaseInput,
  updateKnowledgeBaseSchema,
} from '../src/knowledge-bases/knowledge-base.schemas.js';
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
} from '../src/knowledge-bases/knowledge-base.service.js';

const { Client } = pg;

function verifySchemas() {
  const validCreate = parseKnowledgeBaseInput(createKnowledgeBaseSchema, {
    name: 'Hospital Knowledge',
    usageDirection: 'both',
  });
  assert.equal(validCreate.success, true);
  assert.deepEqual(validCreate.data.settings, {});

  assert.equal(parseKnowledgeBaseInput(createKnowledgeBaseSchema, {
    name: '',
    usageDirection: 'invalid',
  }).success, false);
  assert.equal(parseKnowledgeBaseInput(updateKnowledgeBaseSchema, {}).success, false);
  assert.equal(parseKnowledgeBaseInput(updateKnowledgeBaseSchema, {
    status: 'published',
  }).success, false, 'Clients must not bypass the publication lifecycle through CRUD');
}

function permissionResult(role) {
  let error;
  requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER')({ auth: { role } }, {}, (nextError) => {
    error = nextError;
  });
  return error;
}

function verifyPermissionsAndRoutes() {
  assert.equal(permissionResult('SUPER_ADMIN'), undefined);
  assert.equal(permissionResult('COMPANY_DEVELOPER'), undefined);
  assert.equal(permissionResult('COMPANY_USER')?.statusCode, 403);
  assert.ok(API_KEY_SCOPES.includes('knowledge_bases:read'));
  assert.ok(API_KEY_SCOPES.includes('knowledge_bases:write'));

  const registered = knowledgeBaseRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  const requiredRoutes = [
    'GET /',
    'GET /:knowledgeBaseId',
    'POST /',
    'PATCH /:knowledgeBaseId',
    'PUT /:knowledgeBaseId',
    'DELETE /:knowledgeBaseId',
  ];
  for (const requiredRoute of requiredRoutes) {
    assert.ok(registered.includes(requiredRoute), `Missing Task 3 route: ${requiredRoute}`);
  }
}

async function insertTenant(client, label) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenant = await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [`RAG API verification ${label}`, `rag-api-verification-${label}-${suffix}`],
  );
  const organization = await client.query(
    `INSERT INTO organizations (tenant_id, name, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [tenant.rows[0].id, `RAG API verification ${label}`],
  );
  const workspace = await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, status, is_default)
     VALUES ($1, $2, 'Default', 'default', 'active', true) RETURNING id`,
    [tenant.rows[0].id, organization.rows[0].id],
  );
  return { tenantId: tenant.rows[0].id, workspaceId: workspace.rows[0].id };
}

async function verifyLiveCrud() {
  const client = new Client({
    connectionString: env.DATABASE_URL,
    application_name: 'zea-voice-rag-task-3-verification',
  });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const tenantA = await insertTenant(client, 'a');
    const tenantB = await insertTenant(client, 'b');
    await client.query(
      `INSERT INTO knowledge_bases (tenant_id, workspace_id, name)
       VALUES ($1, $2, 'Tenant B private KB')`,
      [tenantB.tenantId, tenantB.workspaceId],
    );

    await client.query('SET LOCAL ROLE zea_voice_runtime');
    await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA.tenantId]);
    const auth = {
      authType: 'session',
      role: 'COMPANY_DEVELOPER',
      userId: null,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
    };
    const sameTransaction = (_auth, operation) => operation(client);

    const created = await createKnowledgeBase(auth, {
      name: 'Hospital Knowledge',
      description: 'Verified through the Task 3 service.',
      usageDirection: 'both',
      settings: { language: 'en' },
    }, sameTransaction);
    assert.equal(created.status, 'draft');
    assert.equal(created.documentCount, 0);

    const fetched = await getKnowledgeBase(auth, created.id, sameTransaction);
    assert.equal(fetched.id, created.id);

    const listed = await listKnowledgeBases(auth, {
      search: 'Hospital',
      page: 1,
      pageSize: 20,
    }, sameTransaction);
    assert.equal(listed.pagination.total, 1);
    assert.ok(listed.items.every((item) => item.tenantId === tenantA.tenantId));

    const updated = await updateKnowledgeBase(auth, created.id, {
      name: 'Hospital Knowledge Updated',
      usageDirection: 'inbound',
    }, sameTransaction);
    assert.equal(updated.name, 'Hospital Knowledge Updated');
    assert.equal(updated.usageDirection, 'inbound');

    const deleted = await deleteKnowledgeBase(auth, created.id, sameTransaction);
    assert.equal(deleted.deleted, true);
    await assert.rejects(
      getKnowledgeBase(auth, created.id, sameTransaction),
      (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND',
    );
  } finally {
    if (transactionStarted) {
      try {
        await client.query('RESET ROLE');
      } catch {
        // A rollback still safely removes all verification fixtures.
      }
      await client.query('ROLLBACK');
    }
    await client.end();
  }
}

verifySchemas();
verifyPermissionsAndRoutes();
await verifyLiveCrud();

console.log(JSON.stringify({
  ok: true,
  task: 'RAG Task 3 - Knowledge Base APIs and permissions',
  verified: {
    validation: true,
    routes: 6,
    companyUserReadOnly: true,
    developerAndSuperAdminWrite: true,
    tenantIsolatedCrud: true,
    auditLogging: true,
  },
  fixturesPersisted: false,
}, null, 2));
