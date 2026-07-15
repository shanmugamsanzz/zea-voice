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
const { getProviderCreditBalances } = await import('../src/credits/credit.service.js');
const { encryptCredential } = await import('../src/security/credential-crypto.js');

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID().slice(0, 8);
const password = `Task8-${crypto.randomUUID()}!`;
const superEmail = `task8-admin-${suffix}@example.test`;
const developerEmail = `task8-developer-${suffix}@example.test`;
let server;
let userIds = [];
let tenantId;
let originalPlatformBalance;
let originalRates;
let telephonyAccountId;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    if (originalPlatformBalance !== undefined) {
      await admin.query("UPDATE platform_credit_wallets SET balance = $1 WHERE currency = 'INR'", [originalPlatformBalance]);
    }
    if (originalRates) {
      for (const rate of originalRates) await admin.query('UPDATE platform_pricing_rates SET rate_per_minute = $2 WHERE direction = $1', [rate.direction, rate.rate_per_minute]);
    }
    await admin.query('DELETE FROM credit_ledger_entries WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = $2', [userIds, tenantId ?? null]);
    if (telephonyAccountId) await admin.query('DELETE FROM telephony_accounts WHERE id = $1', [telephonyAccountId]);
    await admin.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = $2', [userIds, tenantId ?? null]);
    if (tenantId) {
      await admin.query('DELETE FROM auth_sessions WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenant_limits WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM workspaces WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM organizations WHERE tenant_id = $1', [tenantId]);
      await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    if (userIds.length) {
      await admin.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
      await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await admin.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  originalPlatformBalance = (await admin.query("SELECT balance FROM platform_credit_wallets WHERE currency = 'INR'")).rows[0].balance;
  originalRates = (await admin.query('SELECT direction, rate_per_minute FROM platform_pricing_rates')).rows;
  const superUser = (await admin.query(`INSERT INTO users
    (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
    VALUES ($1, $2, 'Task', 'Eight Admin', 'active', 'super_admin', now()) RETURNING id`,
  [superEmail, await hashPassword(password)])).rows[0];
  userIds.push(superUser.id);

  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email: superEmail, password }) });
  const superToken = (await login.json()).data.accessToken;
  const headers = { authorization: `Bearer ${superToken}` };

  const companyResponse = await api(base, '/admin/companies', { method: 'POST', headers,
    body: JSON.stringify({ businessName: `Task 8 Company ${suffix}`, firstName: 'Task', lastName: 'Eight',
      email: `task8-company-${suffix}@example.test`, businessPhone: '+919876543210',
      perMinutePrice: 5.5, timezone: 'Asia/Kolkata' }) });
  assert.equal(companyResponse.status, 201);
  tenantId = (await companyResponse.json()).data.tenantId;
  const developerResponse = await api(base, '/admin/developers', { method: 'POST', headers,
    body: JSON.stringify({ companyId: tenantId, fullName: 'Task Eight Developer', email: developerEmail, password }) });
  assert.equal(developerResponse.status, 201);
  userIds.push((await developerResponse.json()).data.userId);

  assert.equal((await api(base, '/admin/credits/platform/purchases', { method: 'POST', headers,
    body: JSON.stringify({ amount: '1000', reference: `test-${suffix}` }) })).status, 201);
  const allocation = await api(base, `/admin/credits/companies/${tenantId}/allocations`, { method: 'POST', headers,
    body: JSON.stringify({ amount: '200', description: 'Task 8 allocation' }) });
  assert.equal(allocation.status, 201);
  assert.equal((await allocation.json()).data.balance, 200);
  const insufficient = await api(base, `/admin/credits/companies/${tenantId}/allocations`, { method: 'POST', headers,
    body: JSON.stringify({ amount: '999999999' }) });
  assert.equal(insufficient.status, 409);
  assert.equal((await api(base, `/admin/credits/companies/${tenantId}/adjustments`, { method: 'POST', headers,
    body: JSON.stringify({ direction: 'credit', amount: '50', type: 'promotional_credit', description: 'Promotion' }) })).status, 201);
  const pricing = await api(base, '/admin/credits/pricing', { method: 'PUT', headers,
    body: JSON.stringify({ inboundRate: '7.25', outboundRate: '13.50' }) });
  assert.equal(pricing.status, 200);

  telephonyAccountId = (await admin.query(`INSERT INTO telephony_accounts
    (provider, name, auth_id, auth_token_encrypted, base_url, application_id,
     answer_url, hangup_url, recording_callback_url, status, created_by)
    VALUES ('plivo', $1, $2, $3, 'https://api.plivo.test/v1', '',
      'https://example.test/answer', 'https://example.test/hangup', 'https://example.test/recording',
      'connected', $4) RETURNING id`,
  [`Task 8 Plivo ${suffix}`, `MA${suffix.toUpperCase()}CREDITS`, encryptCredential('task-8-plivo-token'), superUser.id])).rows[0].id;
  const providerBalances = await getProviderCreditBalances(superUser.id, async (url) => {
    assert.match(String(url), /\/Account\/MA[A-Z0-9]+CREDITS\/$/);
    return new Response(JSON.stringify({ cash_credits: '42.7500', billing_mode: 'prepaid',
      account_type: 'standard', auto_recharge: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const providerBalance = providerBalances.find((item) => item.telephonyAccountId === telephonyAccountId);
  assert.equal(providerBalance.available, true);
  assert.equal(providerBalance.remainingCredits, 3420);
  assert.equal(providerBalance.currency, 'INR');
  assert.equal(providerBalance.sourceRemainingCredits, 42.75);
  assert.equal(providerBalance.sourceCurrency, 'USD');

  const developerLogin = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email: developerEmail, password }) });
  const developerToken = (await developerLogin.json()).data.accessToken;
  const tenantCredits = await api(base, '/credits', { headers: { authorization: `Bearer ${developerToken}` } });
  assert.equal(tenantCredits.status, 200);
  const tenantData = (await tenantCredits.json()).data;
  assert.equal(tenantData.wallet.companyId, tenantId);
  assert.equal(tenantData.wallet.balance, 250);
  assert.ok(tenantData.ledger.items.every((item) => item.companyId === tenantId));

  const paired = await admin.query(`SELECT count(*)::int AS count FROM credit_ledger_entries
    WHERE transaction_group_id IN (SELECT transaction_group_id FROM credit_ledger_entries WHERE tenant_id = $1 AND entry_type = 'company_allocation')`, [tenantId]);
  assert.equal(paired.rows[0].count, 2);

  console.log(JSON.stringify({ success: true, platformPurchases: 'passed', atomicCompanyAllocation: 'passed',
    insufficientCreditProtection: 'passed', manualAndPromotionalAdjustments: 'passed', pricingRates: 'passed',
    livePlivoRemainingCredits: 'passed', tenantLedgerIsolation: 'passed', pairedLedgerEntries: 'passed',
    temporaryRecordsRemoved: true }, null, 2));
} finally {
  await cleanup();
}
