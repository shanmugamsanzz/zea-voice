import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'zea-latency-gate-'));
try {
  const path = join(directory, 'live.jsonl');
  const entries = Array.from({ length: 20 }, (_, index) => ({
    stage: 'template_engine.turn_completed', outcome: index % 5 === 0
      ? 'CONVERSATIONAL_RESPONSE' : 'FACTUAL_ANSWER',
    actualAnswerFirstAudioMs: 500 + index * 100, normalVerifiedRequest: true,
    initialDecision: 'SEARCH', finalDecision: 'RESPONSE', searchPerformed: true,
    technicalRecoveryApplied: false, llmInvocationCount: 1,
  }));
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const passed = spawnSync(process.execPath,
    ['scripts/build-production-latency-report.js', path, '--enforce'],
    { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(passed.status, 0,
    'The automatic gate must require latency and retained technical safeguards');
  const report = JSON.parse(passed.stdout);
  assert.equal(report.actualAnswerLatency.count, 20);
  assert.equal(report.actualAnswerLatency.maximumMs, 2400);
  assert.equal(report.liveCorrectness.passed, true);
  assert.equal(report.liveCorrectness.technicalSafeguardsMeasured, true);
  assert.equal(report.releaseGate.passed, true);
  assert.equal(report.releaseGate.reason, null);

  for (const entry of entries) entry.actualAnswerFirstAudioMs = 60_000;
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const averageBoundary = spawnSync(process.execPath,
    ['scripts/build-production-latency-report.js', path, '--enforce'],
    { cwd: process.cwd(), encoding: 'utf8' });
  const slowReport = JSON.parse(averageBoundary.stdout);
  assert.equal(averageBoundary.status, 0,
    'Measured latency must not reject a correct release without a configured target');
  assert.equal(slowReport.actualAnswerLatency.maximumMs, 60_000);
  assert.equal(slowReport.releaseGate.passed, true);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log('Production latency release gate: passed');
