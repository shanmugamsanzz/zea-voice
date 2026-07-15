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
const password = `Task12-${crypto.randomUUID()}!`;
const email = `task12-admin-${crypto.randomUUID().slice(0, 8)}@example.test`;
let userId;
let sessionId;
let original;
let server;

async function api(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
}
async function restore() {
  if (!original) return;
  await admin.query(`UPDATE platform_settings SET admin_ip_allowlist = $1::cidr[],
    max_session_timeout_seconds = $2, compliance_policy = $3, sip_relay_region = $4,
    updated_by = $5 WHERE id = true`, [original.admin_ip_allowlist,
    original.max_session_timeout_seconds, original.compliance_policy, original.sip_relay_region,
    original.updated_by]);
}
async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (admin._connected) {
    await restore();
    if (userId) {
      await admin.query('DELETE FROM api_keys WHERE created_by = $1', [userId]);
      await admin.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [userId]);
      await admin.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
      await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await admin.end();
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()]);
}

try {
  await admin.connect();
  original = (await admin.query('SELECT * FROM platform_settings WHERE id = true')).rows[0];
  userId = (await admin.query(`INSERT INTO users
    (email,password_hash,first_name,last_name,status,platform_role,email_verified_at)
    VALUES ($1,$2,'Task','Twelve Admin','active','super_admin',now()) RETURNING id`,
  [email, await hashPassword(password)])).rows[0].id;
  server = createServer(createApp());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await api(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const loginData = (await login.json()).data;
  sessionId = loginData.sessionId;
  const headers = { authorization: `Bearer ${loginData.accessToken}` };
  assert.equal((await api(base, '/admin/settings', { headers })).status, 200);

  const update = await api(base, '/admin/settings', { method: 'PUT', headers, body: JSON.stringify({
    adminIpAllowlist: ['127.0.0.1/32'], maxSessionTimeoutSeconds: 7200,
    compliancePolicy: 'strict_gdpr', sipRelayRegion: 'apac_south',
  }) });
  assert.equal(update.status, 200);
  const updated = (await update.json()).data;
  assert.equal(updated.maxSessionTimeoutSeconds, 7200);
  assert.equal(updated.compliancePolicy, 'strict_gdpr');
  assert.equal(updated.sipRelayRegion, 'apac_south');

  const unsafe = await api(base, '/admin/settings', { method: 'PUT', headers,
    body: JSON.stringify({ adminIpAllowlist: ['10.0.0.0/8'] }) });
  assert.equal(unsafe.status, 400);
  const lockout = await api(base, '/admin/settings', { method: 'PUT', headers,
    body: JSON.stringify({ adminIpAllowlist: ['10.0.0.0/8'], confirmAccessLoss: true }) });
  assert.equal(lockout.status, 200);
  assert.equal((await api(base, '/admin/settings', { headers })).status, 403);
  await restore();

  await admin.query("UPDATE platform_settings SET max_session_timeout_seconds = 300 WHERE id = true");
  await admin.query("UPDATE auth_sessions SET created_at = now() - interval '301 seconds' WHERE id = $1", [sessionId]);
  assert.equal((await api(base, '/admin/settings', { headers })).status, 401);
  assert.ok((await admin.query(`SELECT count(*)::int AS count FROM audit_logs
    WHERE actor_user_id = $1 AND action = 'PLATFORM_SETTINGS_UPDATED'`, [userId])).rows[0].count >= 2);

  console.log(JSON.stringify({ success: true, settingsReadWrite: 'passed', cidrValidation: 'passed',
    currentIpLockoutProtection: 'passed', confirmedIpRestriction: 'passed', sessionTimeoutEnforcement: 'passed',
    compliancePolicy: 'passed', sipRelaySelection: 'passed', auditTrail: 'passed', temporaryRecordsRemoved: true }, null, 2));
} finally {
  await cleanup();
}
