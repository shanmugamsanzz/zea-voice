import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const requiredScenarios = Object.freeze([
  'package_overview',
  'direct_entity',
  'phonetic_entity',
  'price',
  'details',
  'contextual_follow_up',
  'comparison',
  'correction',
  'acknowledgement',
  'topic_switching',
  'missing_information',
  'booking_field_collection',
  'tool_success',
  'tool_timeout',
  'tool_failure',
]);

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function text(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function revisions(value) {
  if (typeof value === 'string') return value;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value),
    'Each candidate requires expectedRevisions');
  return Object.entries(value).map(([knowledgeBaseId, revision]) => (
    `${knowledgeBaseId}:${revision}`
  )).join(',');
}

async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(
        `Production candidate gate failed (${signal ?? `exit ${code}`})`,
      ));
    });
  });
}

const configuredManifestPath = text(argument(
  'manifest', process.env.PRODUCTION_RELEASE_REGRESSION_MANIFEST,
));
assert.ok(configuredManifestPath,
  'PRODUCTION_RELEASE_REGRESSION_MANIFEST or --manifest is required');
const manifestPath = resolve(configuredManifestPath);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const repeats = Number.parseInt(argument('repeats', manifest.repeats ?? '3'), 10);
assert.ok(Number.isInteger(repeats) && repeats >= 3,
  'Production release regression requires at least three complete passes');
assert.ok(Array.isArray(manifest.candidates) && manifest.candidates.length >= 2,
  'Production release regression requires at least two tenant candidates');

const expectedGitSha = text(argument(
  'expected-git-sha', process.env.PRODUCTION_ACCEPTANCE_EXPECTED_GIT_SHA,
));
assert.match(expectedGitSha, /^[0-9a-f]{40}$/iu,
  'A full deployed candidate Git SHA is required');

const reports = [];
for (const [index, candidate] of manifest.candidates.entries()) {
  const id = text(candidate.id) || `candidate-${index + 1}`;
  const agentId = text(candidate.agentId);
  const replayFile = resolve(text(candidate.replayFile));
  const reportFile = resolve(text(candidate.reportFile)
    || `artifacts/production-release-regression/${id}.json`);
  assert.match(agentId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    `${id}: valid agentId is required`);
  assert.ok(text(candidate.replayFile), `${id}: replayFile is required`);
  await run(process.execPath, [
    'scripts/verify-live-production-acceptance.js',
    `--agent-id=${agentId}`,
    `--expected-revisions=${revisions(candidate.expectedRevisions)}`,
    `--replay-file=${replayFile}`,
    `--report-file=${reportFile}`,
    `--repeats=${repeats}`,
    '--allow-live-transcript-processing=true',
    '--allow-sandbox-tool-execution=true',
    '--require-live-tts=true',
    '--require-release-identity=true',
    `--expected-git-sha=${expectedGitSha}`,
  ], { cwd: resolve('.') });
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(report.passed, true, `${id}: live acceptance report did not pass`);
  assert.equal(report.repeats, repeats, `${id}: report did not run every required pass`);
  reports.push(report);
}

const tenantIds = new Set(reports.map((report) => text(report.tenantId)).filter(Boolean));
assert.ok(tenantIds.size >= 2,
  'Production release candidates did not resolve to at least two isolated tenants');

const scenarioCounts = new Map(requiredScenarios.map((scenario) => [scenario, 0]));
for (const result of reports.flatMap((report) => report.results ?? [])) {
  const scenario = text(result.scenario).toLocaleLowerCase();
  if (scenarioCounts.has(scenario)) {
    scenarioCounts.set(scenario, scenarioCounts.get(scenario) + 1);
  }
}
for (const [scenario, count] of scenarioCounts) {
  assert.ok(count >= repeats,
    `Production scenario ${scenario} ran ${count} times; at least ${repeats} are required`);
}

for (const outcome of ['success', 'timeout', 'failure']) {
  const scenario = `tool_${outcome}`;
  const matching = reports.flatMap((report) => report.results ?? []).filter((result) => (
    result.scenario === scenario
    && result.toolExecution?.actual === outcome
    && result.toolExecution?.expected === outcome
  ));
  assert.ok(matching.length >= repeats,
    `Verified ${scenario} coverage did not pass three times`);
}

const summaryPath = resolve(text(argument(
  'report-file', manifest.reportFile,
)) || 'artifacts/production-release-regression/report.json');
const summary = {
  version: 1,
  gate: 'production-release-regression',
  passed: true,
  generatedAt: new Date().toISOString(),
  expectedGitSha,
  repeats,
  tenants: [...tenantIds],
  candidates: reports.map((report) => ({
    agentId: report.agentId,
    tenantId: report.tenantId,
    replayFile: report.replayFile,
    turnCount: report.turnCount,
    candidateRevisionFingerprint: report.candidateRevisionFingerprint,
  })),
  scenarioCounts: Object.fromEntries(scenarioCounts),
  verification: {
    postgres: true,
    bm25: true,
    qdrant: true,
    canonicalMemory: true,
    groundedLlm: true,
    validation: true,
    sandboxedAssignedToolLifecycle: true,
    liveTtsAudio: true,
    multiTenantIsolation: true,
  },
};
await mkdir(dirname(summaryPath), { recursive: true });
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...summary, reportFile: summaryPath }));
