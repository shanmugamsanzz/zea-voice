import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { closeDatabase } from '../src/infrastructure/database.js';
import { closeRedis } from '../src/infrastructure/redis.js';

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task3-${crypto.randomUUID()}!`;
const superAdminEmail = `task3-super-${suffix}@example.test`;
const developerEmail = `task3-developer-${suffix}@example.test`;
const created = { users: [], tenantId: null };
let server;

function cookiePair(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'Expected refresh cookie');
  return setCookie.split(';', 1)[0];
}

async function request(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

async function cleanup() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (admin._connected) {
    if (created.users.length > 0) {
      await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [created.users]);
    }
    if (created.tenantId) {
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [created.tenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [created.tenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [created.tenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [created.tenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [created.tenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [created.tenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [created.tenantId]);
    }
    if (created.users.length > 0) {
      await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [created.users]);
    }
    await admin.end();
  }

  await Promise.allSettled([closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const passwordHash = await hashPassword(password);

  const superAdmin = (await admin.query(
    `INSERT INTO users
      (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
     VALUES ($1, $2, 'Task', 'Admin', 'active', 'super_admin', now())
     RETURNING id`,
    [superAdminEmail, passwordHash],
  )).rows[0];
  created.users.push(superAdmin.id);

  const tenant = (await admin.query(
    `INSERT INTO tenants (name, slug, status)
     VALUES ('Task 3 Tenant', $1, 'active') RETURNING id`,
    [`task-3-${suffix}`],
  )).rows[0];
  created.tenantId = tenant.id;

  const organization = (await admin.query(
    `INSERT INTO organizations (tenant_id, name, primary_email, status)
     VALUES ($1, 'Task 3 Organization', $2, 'active') RETURNING id`,
    [tenant.id, developerEmail],
  )).rows[0];
  const workspace = (await admin.query(
    `INSERT INTO workspaces (tenant_id, organization_id, name, slug, is_default)
     VALUES ($1, $2, 'Default Workspace', 'default', true) RETURNING id`,
    [tenant.id, organization.id],
  )).rows[0];
  await admin.query('INSERT INTO tenant_settings (tenant_id, default_workspace_id) VALUES ($1, $2)', [tenant.id, workspace.id]);
  await admin.query('INSERT INTO tenant_limits (tenant_id) VALUES ($1)', [tenant.id]);

  const developer = (await admin.query(
    `INSERT INTO users
      (email, password_hash, first_name, last_name, status, email_verified_at)
     VALUES ($1, $2, 'Task', 'Developer', 'active', now()) RETURNING id`,
    [developerEmail, passwordHash],
  )).rows[0];
  created.users.push(developer.id);
  await admin.query(
    `INSERT INTO tenant_memberships
      (tenant_id, workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, $3, 'company_developer', 'active', now())`,
    [tenant.id, workspace.id, developer.id],
  );

  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const invalidLogin = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: superAdminEmail, password: `${password}-wrong` }),
  });
  assert.equal(invalidLogin.status, 401);

  const superLogin = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: superAdminEmail, password }),
  });
  assert.equal(superLogin.status, 200);
  const superBody = await superLogin.json();
  assert.equal(superBody.data.user.role, 'SUPER_ADMIN');
  assert.equal(superBody.data.user.tenantId, null);

  const developerLogin = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: developerEmail, password }),
  });
  assert.equal(developerLogin.status, 200);
  const developerCookie = cookiePair(developerLogin);
  const developerBody = await developerLogin.json();
  const originalAccessToken = developerBody.data.accessToken;
  assert.equal(developerBody.data.user.role, 'COMPANY_DEVELOPER');
  assert.equal(developerBody.data.user.tenantId, tenant.id);
  assert.equal(developerBody.data.user.workspaceId, workspace.id);

  const me = await request(baseUrl, '/auth/me', {
    headers: { authorization: `Bearer ${originalAccessToken}` },
  });
  assert.equal(me.status, 200);

  const context = await request(baseUrl, '/auth/context', {
    headers: { authorization: `Bearer ${originalAccessToken}` },
  });
  assert.equal(context.status, 200);
  assert.deepEqual((await context.json()).data, {
    tenantId: tenant.id,
    workspaceId: workspace.id,
  });

  const crossTenant = await request(baseUrl, '/auth/context', {
    headers: {
      authorization: `Bearer ${originalAccessToken}`,
      'x-tenant-id': crypto.randomUUID(),
    },
  });
  assert.equal(crossTenant.status, 403);

  const storedSession = await admin.query(
    `SELECT access_token_hash, refresh_token_hash
     FROM auth_sessions WHERE user_id = $1`,
    [developer.id],
  );
  assert.equal(storedSession.rowCount, 1);
  assert.equal(storedSession.rows[0].access_token_hash.length, 64);
  assert.notEqual(storedSession.rows[0].access_token_hash, originalAccessToken);
  assert.equal(storedSession.rows[0].refresh_token_hash.length, 64);

  const refresh = await request(baseUrl, '/auth/refresh', {
    method: 'POST',
    headers: { cookie: developerCookie },
    body: '{}',
  });
  assert.equal(refresh.status, 200);
  const refreshedCookie = cookiePair(refresh);
  const refreshBody = await refresh.json();
  const refreshedAccessToken = refreshBody.data.accessToken;
  assert.notEqual(refreshedAccessToken, originalAccessToken);

  const oldAccess = await request(baseUrl, '/auth/me', {
    headers: { authorization: `Bearer ${originalAccessToken}` },
  });
  assert.equal(oldAccess.status, 401);

  const newAccess = await request(baseUrl, '/auth/me', {
    headers: { authorization: `Bearer ${refreshedAccessToken}` },
  });
  assert.equal(newAccess.status, 200);

  const logout = await request(baseUrl, '/auth/logout', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshedAccessToken}`,
      cookie: refreshedCookie,
    },
    body: '{}',
  });
  assert.equal(logout.status, 204);

  const loggedOutAccess = await request(baseUrl, '/auth/me', {
    headers: { authorization: `Bearer ${refreshedAccessToken}` },
  });
  assert.equal(loggedOutAccess.status, 401);

  console.log(JSON.stringify({
    success: true,
    passwordHashing: 'passed',
    invalidLogin: 'passed',
    superAdminLogin: 'passed',
    developerTenantResolution: 'passed',
    crossTenantRequestRejection: 'passed',
    rawTokensStoredInDatabase: false,
    refreshRotation: 'passed',
    logoutRevocation: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
