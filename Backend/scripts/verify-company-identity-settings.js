import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');
const { closeQueues } = await import('../src/queues/queue.registry.js');

const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = 'CompanyIdentity-' + crypto.randomUUID() + '!';
const tenants = [];
const users = [];
let server;

async function api(base, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
}

async function login(base, email) {
  const response = await api(base, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.accessToken;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (database._connected) {
    for (const tenantId of tenants) {
      const members = await database.query('SELECT user_id FROM tenant_memberships WHERE tenant_id=$1', [tenantId]);
      users.push(...members.rows.map((row) => row.user_id));
      for (const table of ['audit_logs', 'auth_sessions', 'tenant_memberships', 'company_credit_wallets',
        'tenant_settings', 'tenant_limits', 'workspaces', 'organizations']) {
        await database.query('DELETE FROM ' + table + ' WHERE tenant_id=$1', [tenantId]);
      }
      await database.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    }
    if (users.length) {
      const ids = [...new Set(users)];
      await database.query('DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])', [ids]);
      await database.query('DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [ids]);
      await database.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
    }
    await database.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  const adminSource = await readFile(
    new URL('../../Frontend/src/components/views/SuperAdminViews.tsx', import.meta.url),
    'utf8',
  );
  const companySource = await readFile(
    new URL('../../Frontend/src/components/views/CompanyViews.tsx', import.meta.url),
    'utf8',
  );
  assert.match(adminSource, />Organization Name</);
  assert.match(adminSource, />Workspace Name</);
  assert.match(adminSource, /businessName, organizationName, workspaceName/);
  const settingsStart = companySource.indexOf('function CompanySettingsView()');
  const settingsEnd = companySource.indexOf('function CompanyIntegrationsView()', settingsStart);
  const settingsSource = companySource.slice(settingsStart, settingsEnd);
  assert.match(settingsSource, /\/settings\/profile/);
  assert.match(settingsSource, /Organization ID/);
  assert.match(settingsSource, /Tenant ID/);
  assert.match(settingsSource, /Workspace ID/);
  assert.match(settingsSource, /Full Name/);
  assert.match(settingsSource, /Email Address/);
  assert.doesNotMatch(settingsSource, /zea_live_|hooks\.mycompany|defaultValue/);

  await database.connect();
  const adminEmail = 'identity-admin-' + suffix + '@example.test';
  const admin = (await database.query(
    "INSERT INTO users(email,password_hash,first_name,last_name,status,platform_role,email_verified_at) "
      + "VALUES($1,$2,'Identity','Admin','active','super_admin',now()) RETURNING id",
    [adminEmail, await hashPassword(password)],
  )).rows[0];
  users.push(admin.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const adminHeaders = { authorization: 'Bearer ' + await login(base, adminEmail) };

  async function company(label) {
    const emailAddress = ('identity-company-' + label + '-' + suffix + '@example.test').toLowerCase();
    const expected = {
      businessName: 'Identity Company ' + label + ' ' + suffix,
      organizationName: 'Identity Organization ' + label + ' ' + suffix,
      workspaceName: 'Identity Workspace ' + label + ' ' + suffix,
    };
    const body = {
      ...expected,
      legalName: expected.businessName,
      firstName: 'Identity',
      lastName: 'Owner',
      email: emailAddress,
      businessPhone: '+919999999999',
      website: 'https://example.test',
      billingTier: 'starter',
      perMinutePrice: 6.4,
      addressLine1: 'Test Street',
      state: 'Tamil Nadu',
      country: 'India',
      postalCode: '600001',
      timezone: 'Asia/Kolkata',
      status: 'active',
      locale: 'en-US',
      currency: 'INR',
    };
    assert.equal(Object.hasOwn(body, 'organizationId'), false);
    assert.equal(Object.hasOwn(body, 'workspaceId'), false);
    const response = await api(base, '/admin/companies', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    tenants.push(payload.data.tenantId);
    return {
      ...payload.data,
      expected: { ...expected, fullName: 'Identity Owner', emailAddress },
    };
  }

  async function member(companyId, email, role) {
    const response = await api(base, '/admin/developers', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ companyId, fullName: 'Identity Member', email, password, role }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    users.push(payload.data.userId);
  }

  const companyA = await company('A');
  const companyB = await company('B');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(companyA.organizationId, uuid);
  assert.match(companyA.workspaceId, uuid);
  assert.equal(companyA.organizationName, companyA.expected.organizationName);
  assert.equal(companyA.workspaceName, companyA.expected.workspaceName);

  const stored = (await database.query(
    "SELECT organization.id AS organization_id, organization.name AS organization_name, "
      + "workspace.id AS workspace_id, workspace.name AS workspace_name "
      + "FROM organizations organization JOIN workspaces workspace "
      + "ON workspace.tenant_id=organization.tenant_id AND workspace.organization_id=organization.id "
      + "WHERE organization.tenant_id=$1",
    [companyA.tenantId],
  )).rows[0];
  assert.deepEqual(stored, {
    organization_id: companyA.organizationId,
    organization_name: companyA.expected.organizationName,
    workspace_id: companyA.workspaceId,
    workspace_name: companyA.expected.workspaceName,
  });

  const developerEmail = 'identity-developer-' + suffix + '@example.test';
  const userEmail = 'identity-user-' + suffix + '@example.test';
  const otherEmail = 'identity-other-' + suffix + '@example.test';
  await member(companyA.tenantId, developerEmail, 'COMPANY_DEVELOPER');
  await member(companyA.tenantId, userEmail, 'COMPANY_USER');
  await member(companyB.tenantId, otherEmail, 'COMPANY_DEVELOPER');

  const developerHeaders = { authorization: 'Bearer ' + await login(base, developerEmail) };
  const profileResponse = await api(base, '/settings/profile', { headers: developerHeaders });
  assert.equal(profileResponse.status, 200);
  assert.deepEqual((await profileResponse.json()).data, {
    fullName: companyA.expected.fullName,
    emailAddress: companyA.expected.emailAddress,
    organizationName: companyA.expected.organizationName,
    workspaceName: companyA.expected.workspaceName,
    organizationId: companyA.organizationId,
    tenantId: companyA.tenantId,
    workspaceId: companyA.workspaceId,
  });

  const otherHeaders = { authorization: 'Bearer ' + await login(base, otherEmail) };
  const otherProfile = (await (await api(base, '/settings/profile', { headers: otherHeaders })).json()).data;
  assert.equal(otherProfile.tenantId, companyB.tenantId);
  assert.ok(!JSON.stringify(otherProfile).includes(companyA.organizationId));
  assert.equal((await api(base, '/settings/profile', {
    headers: {
      ...developerHeaders,
      'x-tenant-id': companyB.tenantId,
      'x-workspace-id': companyB.workspaceId,
    },
  })).status, 403);
  const userHeaders = { authorization: 'Bearer ' + await login(base, userEmail) };
  assert.equal((await api(base, '/settings/profile', { headers: userHeaders })).status, 403);

  console.log(JSON.stringify({
    success: true,
    task: 'Company organization/workspace identity settings',
    explicitNames: 'passed',
    generatedIdentifiers: 'passed',
    persistedDatabaseIdentity: 'passed',
    developerReadOnlyProfile: 'passed',
    companyContactProfile: 'passed',
    noMockSettingsData: 'passed',
    tenantIsolation: 'passed',
    temporaryRecordsRemoved: true,
  }, null, 2));
} finally {
  await cleanup();
}
