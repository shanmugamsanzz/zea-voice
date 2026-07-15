import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';

const expectedTables = [
  'audit_logs',
  'organizations',
  'tenant_limits',
  'tenant_settings',
  'tenants',
  'workspaces',
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function expectDatabaseError(operation, expectedCode) {
  await client.query('SAVEPOINT expected_error');
  try {
    await operation();
    assert.fail(`Expected PostgreSQL error ${expectedCode}`);
  } catch (error) {
    assert.equal(error.code, expectedCode);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_error');
    await client.query('RELEASE SAVEPOINT expected_error');
  }
}

try {
  await client.connect();

  const tablesResult = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [expectedTables]);
  assert.deepEqual(tablesResult.rows.map((row) => row.table_name), expectedTables);

  const rlsResult = await client.query(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname = ANY($1::text[])
    ORDER BY relname
  `, [expectedTables]);
  assert.equal(rlsResult.rowCount, expectedTables.length);
  for (const table of rlsResult.rows) {
    assert.equal(table.relrowsecurity, true, `${table.relname} must enable RLS`);
    assert.equal(table.relforcerowsecurity, true, `${table.relname} must force RLS`);
  }

  const runtimeRoleResult = await client.query(`
    SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
    FROM pg_roles
    WHERE rolname = 'zea_voice_runtime'
  `);
  assert.equal(runtimeRoleResult.rowCount, 1);
  assert.deepEqual(runtimeRoleResult.rows[0], {
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolbypassrls: false,
  });

  const requiredConstraints = [
    'organizations_one_per_tenant',
    'workspaces_organization_tenant_fk',
    'workspaces_tenant_slug_unique',
    'tenant_limits_campaign_within_total',
    'audit_logs_workspace_tenant_fk',
  ];
  const constraintsResult = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conname = ANY($1::text[])
    ORDER BY conname
  `, [requiredConstraints]);
  assert.deepEqual(
    constraintsResult.rows.map((row) => row.conname),
    [...requiredConstraints].sort(),
  );

  const suffix = crypto.randomUUID().slice(0, 8);
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE zea_voice_runtime');
  await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");

  const tenantA = (await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    ['Task 2 Tenant A', `task-2-a-${suffix}`],
  )).rows[0].id;
  const tenantB = (await client.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ($1, $2, 'active') RETURNING id`,
    ['Task 2 Tenant B', `task-2-b-${suffix}`],
  )).rows[0].id;

  const organizationA = (await client.query(
    `INSERT INTO organizations (tenant_id, name, primary_email, status)
     VALUES ($1, 'Organization A', 'a@example.test', 'active') RETURNING id`,
    [tenantA],
  )).rows[0].id;
  const organizationB = (await client.query(
    `INSERT INTO organizations (tenant_id, name, primary_email, status)
     VALUES ($1, 'Organization B', 'b@example.test', 'active') RETURNING id`,
    [tenantB],
  )).rows[0].id;

  const workspaceA = (await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, is_default)
     VALUES ($1, $2, 'Default Workspace', 'default', true) RETURNING id`,
    [tenantA, organizationA],
  )).rows[0].id;
  await client.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, is_default)
     VALUES ($1, $2, 'Default Workspace', 'default', true)`,
    [tenantB, organizationB],
  );

  await client.query(
    'INSERT INTO tenant_settings (tenant_id, default_workspace_id) VALUES ($1, $2)',
    [tenantA, workspaceA],
  );
  await client.query('INSERT INTO tenant_limits (tenant_id) VALUES ($1), ($2)', [tenantA, tenantB]);
  await client.query(
    `INSERT INTO audit_logs (tenant_id, workspace_id, actor_type, action, entity_type)
     VALUES ($1, $2, 'system', 'TASK_2_VERIFY', 'tenant')`,
    [tenantA, workspaceA],
  );

  await expectDatabaseError(
    () => client.query(
      `INSERT INTO workspaces (tenant_id, organization_id, name, slug)
       VALUES ($1, $2, 'Invalid Cross Tenant', 'invalid-cross-tenant')`,
      [tenantA, organizationB],
    ),
    '23503',
  );

  await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);

  const visibleTenants = await client.query('SELECT id FROM tenants ORDER BY id');
  assert.equal(visibleTenants.rowCount, 1);
  assert.equal(visibleTenants.rows[0].id, tenantA);

  const visibleOrganizations = await client.query('SELECT tenant_id FROM organizations');
  assert.equal(visibleOrganizations.rowCount, 1);
  assert.equal(visibleOrganizations.rows[0].tenant_id, tenantA);

  const visibleWorkspaces = await client.query('SELECT tenant_id FROM workspaces');
  assert.equal(visibleWorkspaces.rowCount, 1);
  assert.equal(visibleWorkspaces.rows[0].tenant_id, tenantA);

  const hiddenTenantUpdate = await client.query(
    "UPDATE tenants SET name = 'Should Stay Hidden' WHERE id = $1",
    [tenantB],
  );
  assert.equal(hiddenTenantUpdate.rowCount, 0);

  await expectDatabaseError(
    () => client.query(
      `INSERT INTO audit_logs (tenant_id, actor_type, action, entity_type)
       VALUES ($1, 'api', 'INVALID_CROSS_TENANT', 'tenant')`,
      [tenantB],
    ),
    '42501',
  );

  await client.query('ROLLBACK');

  console.log(JSON.stringify({
    success: true,
    tables: expectedTables,
    forcedRowLevelSecurity: true,
    restrictedRuntimeRole: true,
    tenantVisibilityTest: 'passed',
    crossTenantForeignKeyTest: 'passed',
    crossTenantWriteTest: 'passed',
    temporaryRowsPersisted: false,
  }, null, 2));
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Connection may already be closed or no transaction may be active.
  }
  throw error;
} finally {
  await client.end();
}
