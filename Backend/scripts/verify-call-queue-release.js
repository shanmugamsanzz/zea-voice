import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../', import.meta.url));
const liveRedis = process.argv.includes('--redis');
const release = process.argv.includes('--release');
const report = { passed: false, releaseReady: false, mode: liveRedis ? 'real_redis' : 'simulation',
  startedAt: new Date().toISOString(), checks: [], limitations: [
    'Campaign database transactions and telephony dialing use test doubles.',
    'Provider calls, physical container restarts and live load/latency require staging verification.',
  ] };
const checks = [
  ['queue feature flag and rollback', 'verify-company-queue-feature.js'],
  ['capacity, duplicates and expired leases', 'verify-company-call-capacity.js', true],
  ['100 mixed-source outbound tasks, limit 3', 'verify-outbound-capacity-queues.js', true],
  ['mixed inbound/outbound, FIFO, reconstructed services and isolation', 'verify-inbound-waiting-queue.js', true],
  ['company settings, permissions and cancellation races', 'verify-company-queue-settings-and-access.js'],
  ['signed Plivo callbacks', 'verify-voice-task-1.js'],
  ['agent answer admission', 'verify-voice-task-2.js'],
  ['callback continuity', 'verify-callback-continuity.js'],
  ['metered billing', 'verify-metered-call-billing-and-reports.js'],
  ['existing agent runtime and RAG regression suite', 'verify-qdrant-architecture-e2e.js'],
];
try {
  for (const [name, script, usesRedis] of checks) {
    const args = [`scripts/${script}`, ...(liveRedis && usesRedis ? ['--redis'] : [])];
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: backend, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, VOICE_COMPANY_QUEUE_ENABLED: 'false', VOICE_COMPANY_QUEUE_TENANT_IDS: '' } });
    const passed = result.status === 0 && !result.error;
    report.checks.push({ name, passed, durationMs: Date.now() - started });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (!passed) throw new Error(`${name}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  if (release) {
    assert.ok(liveRedis, 'Release gate requires --redis; simulations cannot authorize rollout.');
    const { database, checkDatabase, closeDatabase } = await import('../src/infrastructure/database.js');
    try {
      await checkDatabase();
      const columns = await database.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tenant_limits'
          AND column_name IN ('max_inbound_queue_size','max_inbound_wait_seconds','max_outbound_queued_tasks')`);
      assert.equal(columns.rowCount, 3, 'Apply the company queue settings migration before rollout.');
      const values = await database.query(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
        WHERE t.typname='campaign_queue_reason' AND enumlabel IN ('company_capacity','campaign_capacity','coordination_unavailable')`);
      assert.equal(values.rowCount, 3, 'Queue reason migration is missing.');
      report.checks.push({ name: 'live PostgreSQL restricted role and migration', passed: true });
    } finally { await closeDatabase(); }
    // Staging evidence is explicit; a simulation or schema check is insufficient.
    const evidencePath = process.env.CALL_QUEUE_STAGING_EVIDENCE;
    assert.ok(evidencePath, 'Release gate requires CALL_QUEUE_STAGING_EVIDENCE (see docs/call-queue-release.md).');
    const { readFile } = await import('node:fs/promises');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: backend, encoding: 'utf8' });
    assert.equal(revision.status, 0, 'Cannot identify the release revision.');
    assert.equal(evidence.commit, revision.stdout.trim(), 'Staging evidence must match this commit.');
    const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: backend, encoding: 'utf8' });
    assert.equal(dirty.status, 0); assert.equal(dirty.stdout.trim(), '', 'Commit the tested release before using staging evidence.');
    assert.ok(Date.now() - new Date(evidence.testedAt).getTime() >= 0 && Date.now() - new Date(evidence.testedAt).getTime() < 86400000,
      'Staging evidence must be from the last 24 hours.');
    for (const scenario of ['mixedTraffic', 'hundredTasksLimitThree', 'duplicateCallbacks', 'backendRestart', 'redisRestart', 'companyIsolation', 'rollbackDrain']) {
      assert.equal(evidence.scenarios?.[scenario]?.passed, true, `Missing staging scenario: ${scenario}`);
      assert.ok(typeof evidence.scenarios[scenario].evidence === 'string' && evidence.scenarios[scenario].evidence.trim(), `Missing logs for ${scenario}`);
    }
    report.checks.push({ name: 'staging traffic and restart evidence for current revision', passed: true });
    report.releaseReady = true;
  }
  report.passed = true;
  if (!release) console.log('Local checks passed. Production rollout stays disabled until the --redis --release gate and staging evidence pass.');
} catch (error) {
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  const output = new URL('../reports/call-queue-release.json', import.meta.url);
  await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Queue verification report: ${fileURLToPath(output)}`);
}
