import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = [
  'verify-agent-call-transfer-settings.js', 'verify-native-call-transfer.js',
  'verify-plivo-playback-ack.js',
  'verify-transfer-follow-up.js', 'verify-transfer-runtime-resume.js', 'verify-transfer-media-ownership.js', 'verify-transfer-audio.js',
  'verify-agent-webhook-tools.js', 'verify-template-engine-production-runtime.js',
  'verify-tool-result-call-control.js', 'verify-follow-up-scheduling.js',
  'verify-company-call-capacity.js', 'verify-browser-test-media.js', 'verify-plivo-hangup-cause-logging.js',
];
const results = [];
for (const script of scripts) {
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, NODE_ENV: 'test', CALL_TRANSFER_ENABLED: 'false',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost/test',
      REDIS_HOST: process.env.REDIS_HOST ?? 'localhost' },
  });
  const passed = execution.status === 0;
  results.push({ script, passed });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${script}\n`);
  if (!passed) process.stderr.write(execution.stderr || execution.stdout || execution.error?.message || 'Check failed\n');
}
const passed = results.every(result => result.passed);
console.log(JSON.stringify({ suite: 'call-transfer-release', passed, checks: results.length,
  livePlivoPilot: 'not_run', liveDatabaseMigration: 'not_run', rolloutDefault: 'off', requiresExplicitAgentAllowlist: false }));
if (!passed) process.exitCode = 1;
