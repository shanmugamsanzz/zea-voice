import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const checks = Object.freeze([
  Object.freeze({ name: 'conversation replay', script: 'scripts/verify-multi-agent-conversation-replay.js' }),
  Object.freeze({ name: 'workflow and action replay', script: 'scripts/verify-agent-qdrant-grounded-turn.js' }),
  Object.freeze({ name: 'conversation context replay', script: 'scripts/verify-universal-turn-context.js' }),
  Object.freeze({ name: 'interruption replay', script: 'scripts/verify-interruption-audio-isolation.js' }),
  Object.freeze({ name: 'strict latency release gate', script: 'scripts/verify-production-latency-release-gate.js' }),
]);

for (const check of checks) {
  const result = spawnSync(process.execPath, [check.script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0,
    `${check.name} failed\n${result.stdout}\n${result.stderr}`);
}

console.log(JSON.stringify({
  passed: true,
  behaviorChanged: false,
  scenarios: Object.freeze([
    'multilingual', 'follow_up', 'missing_knowledge', 'booking',
    'correction', 'cancellation', 'interruption',
  ]),
  architecture: Object.freeze({ queryEmbeddingsPerTurn: 1, qdrantSearchesPerTurn: 1,
    maximumLlmCallsPerTurn: 1 }),
  latencyGate: Object.freeze({ minimumLiveSamples: 20,
    averageFinalAnswerFirstAudioMs: '<2000', normalMaximumFirstAudioMs: '<3000' }),
}));
