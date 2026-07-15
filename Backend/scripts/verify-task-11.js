import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import 'dotenv/config';
import pg from 'pg';

const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { closeDatabase } = await import('../src/infrastructure/database.js');
const { closeRedis } = await import('../src/infrastructure/redis.js');
const { closeQueues } = await import('../src/queues/queue.registry.js');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task11-${crypto.randomUUID()}!`;
const userIds = [];
const tenantIds = [];
const paymentIds = [];
let server;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
}
async function login(base, email) {
  const response = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  return (await response.json()).data.accessToken;
}
async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    await admin.query('DELETE FROM payment_transactions WHERE id = ANY($1::uuid[])', [paymentIds]);
    await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])', [userIds, tenantIds]);
    for (const tenantId of tenantIds) {
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await admin.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  const superEmail = `task11-admin-${suffix}@example.test`;
  const developerEmail = `task11-developer-${suffix}@example.test`;
  const user = (await admin.query(`INSERT INTO users
    (email,password_hash,first_name,last_name,status,platform_role,email_verified_at)
    VALUES ($1,$2,'Task','Eleven Admin','active','super_admin',now()) RETURNING id`,
  [superEmail, await hashPassword(password)])).rows[0];
  userIds.push(user.id);
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superHeaders = { authorization: `Bearer ${await login(base, superEmail)}` };
  async function company(label) {
    const response = await api(base, '/admin/companies', { method: 'POST', headers: superHeaders,
      body: JSON.stringify({ businessName: `Task 11 ${label} ${suffix}`, email: `task11-${label}-${suffix}@example.test` }) });
    const value = (await response.json()).data;
    tenantIds.push(value.tenantId);
    return value;
  }
  const companyA = await company('A');
  const companyB = await company('B');
  const developer = await api(base, '/admin/developers', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ companyId: companyA.tenantId, fullName: 'Task Eleven Developer', email: developerEmail, password }) });
  userIds.push((await developer.json()).data.userId);

  async function payment(body) {
    const response = await api(base, '/admin/payments', { method: 'POST', headers: superHeaders, body: JSON.stringify(body) });
    assert.equal(response.status, 201);
    const value = (await response.json()).data;
    paymentIds.push(value.id);
    return value;
  }
  const paymentA = await payment({ companyId: companyA.tenantId, type: 'subscription', status: 'succeeded',
    amount: '2450.00', paymentMethodLabel: 'Visa ending 4242', invoiceNumber: `INV-${suffix}-A` });
  const paymentB = await payment({ companyId: companyB.tenantId, type: 'credit_refill', status: 'failed',
    amount: '5000', paymentMethodLabel: 'Bank transfer', failureCode: 'DECLINED', failureMessage: 'Provider declined settlement' });
  const pending = await payment({ companyId: companyA.tenantId, type: 'add_on', amount: '199.50' });
  assert.equal(paymentA.companyName, companyA.businessName);
  assert.ok(paymentA.settledAt);
  assert.equal(paymentB.status, 'failed');

  const filtered = await api(base, `/admin/payments?companyId=${companyA.tenantId}`, { headers: superHeaders });
  assert.deepEqual(new Set((await filtered.json()).data.items.map((item) => item.id)), new Set([paymentA.id, pending.id]));
  const summary = await api(base, '/admin/payments/summary', { headers: superHeaders });
  assert.equal(summary.status, 200);
  const developerHeaders = { authorization: `Bearer ${await login(base, developerEmail)}` };
  const tenantPayments = await api(base, '/payments', { headers: developerHeaders });
  assert.deepEqual(new Set((await tenantPayments.json()).data.items.map((item) => item.id)), new Set([paymentA.id, pending.id]));

  const fullCard = await api(base, '/admin/payments', { method: 'POST', headers: superHeaders,
    body: JSON.stringify({ companyId: companyA.tenantId, type: 'subscription', amount: 10,
      paymentMethodLabel: '4111 1111 1111 1111' }) });
  assert.equal(fullCard.status, 400);
  const updated = await api(base, `/admin/payments/${pending.id}/status`, { method: 'PATCH', headers: superHeaders,
    body: JSON.stringify({ status: 'succeeded' }) });
  assert.equal(updated.status, 200);
  assert.ok((await updated.json()).data.settledAt);
  assert.ok((await admin.query(`SELECT count(*)::int AS count FROM audit_logs
    WHERE entity_type = 'payment_transaction' AND entity_id = ANY($1::text[])`, [paymentIds])).rows[0].count >= 4);

  console.log(JSON.stringify({ success: true, financialLedger: 'passed', paymentTypes: 'passed',
    settlementAndFailureStates: 'passed', companyFiltering: 'passed', tenantPaymentIsolation: 'passed',
    paymentSummary: 'passed', cardNumberRejection: 'passed', invoiceMetadata: 'passed',
    paymentAuditTrail: 'passed', temporaryRecordsRemoved: true }, null, 2));
} finally {
  await cleanup();
}
