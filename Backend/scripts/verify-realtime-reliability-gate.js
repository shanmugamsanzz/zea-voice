import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { configuredCallDurationMs } from '../src/voice/interaction/call-duration-policy.js';
import { env } from '../src/config/env.js';

const minimumRepeats = 3;
const requestedRepeats = Number(process.argv.find((value) => value.startsWith('--repeats='))
  ?.split('=')[1] ?? process.env.REALTIME_RELIABILITY_REPEATS ?? minimumRepeats);
const repeats = Math.max(minimumRepeats, Math.min(10,
  Number.isInteger(requestedRepeats) ? requestedRepeats : minimumRepeats));
const suiteTimeoutMs = 60_000;
const maximumRepeatMs = 300_000;

const fixture = JSON.parse(await readFile(new URL(
  '../fixtures/complete-live-call-2026-08-20-regression.json', import.meta.url,
), 'utf8'));
const latestLiveCall = JSON.parse(await readFile(new URL(
  '../fixtures/latest-live-call-2026-08-21-regression.json', import.meta.url,
), 'utf8'));
const expectedBehaviors = new Set(fixture.turns.map((turn) => turn.expect));
for (const behavior of [
  'contextual_response', 'tenant_entity', 'stt_tenant_entity', 'tenant_category',
  'topic_change', 'comparison', 'safety', 'configured_action',
]) assert.ok(expectedBehaviors.has(behavior), `Complete-call fixture is missing ${behavior}`);
const actionTurn = fixture.turns.find((turn) => turn.expect === 'configured_action');
assert.equal(actionTurn?.requiresConfirmation, true);
assert.equal(actionTurn?.requiresVerifiedSuccess, true);
assert.ok(latestLiveCall.turns.some((turn) => turn.kind === 'acknowledgement'));
assert.ok(latestLiveCall.turns.filter((turn) => turn.id.startsWith('onco-')).length >= 4);
for (const requiredKind of ['category', 'item', 'faq', 'booking', 'confirmation']) {
  assert.ok(latestLiveCall.turns.some((turn) => turn.kind === requiredKind),
    `Latest live-call fixture is missing ${requiredKind}`);
}
assert.ok(latestLiveCall.turns.some((turn) => turn.expectedItemKey?.includes('silver')));
assert.ok(latestLiveCall.turns.some((turn) => turn.expectedItemKey?.includes('gold')));
assert.ok(latestLiveCall.turns.filter((turn) => turn.interruptedPreviousAudio).length >= 4);
assert.equal(latestLiveCall.requirements.maximumKnownRequestLlmTimeouts, 0);
assert.equal(latestLiveCall.requirements.maximumFirstAudioMs, 2_000);
assert.ok(latestLiveCall.requirements.minimumSuccessfulRuns >= minimumRepeats);

assert.equal(configuredCallDurationMs(5), 300_000,
  'A configured five-minute call limit must arm exactly at five minutes');
assert.equal(configuredCallDurationMs(0), null);
assert.equal(env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000);
assert.ok(env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);

const suites = Object.freeze([
  { name: 'tamil_knowledge_engine', file: 'verify-tamil-live-call-knowledge-engine.js' },
  { name: 'latest_live_call', file: 'verify-latest-live-call-equivalent-replay.js' },
  { name: 'complete_call', file: 'verify-complete-health-call-production-replay.js' },
  { name: 'tenant_variations', file: 'verify-tenant-regression-generator.js' },
  { name: 'entity_routing', file: 'verify-universal-entity-routing.js' },
  { name: 'grounded_turn', file: 'verify-unified-grounded-turn.js' },
  { name: 'workflow_activation', file: 'verify-latest-turn-workflow-gating.js' },
  { name: 'booking_and_safety', file: 'verify-grounding-action-runtime.js' },
  { name: 'interruptions', file: 'verify-interruption-engine.js' },
  { name: 'interruption_audio', file: 'verify-interruption-audio-isolation.js' },
  { name: 'transcript_and_latency', file: 'verify-live-latency-transcript-hardening.js' },
  { name: 'latency_contract', file: 'verify-production-latency-contract.js' },
  { name: 'tts_failure_contract', file: 'verify-voice-tts.js' },
]);

function runSuite(suite) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [`scripts/${suite.file}`], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let errorOutput = '';
    const retain = (current, chunk) => `${current}${chunk}`.slice(-40_000);
    child.stdout.on('data', (chunk) => { output = retain(output, chunk); });
    child.stderr.on('data', (chunk) => { errorOutput = retain(errorOutput, chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${suite.name} exceeded ${suiteTimeoutMs}ms`));
    }, suiteTimeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const durationMs = performance.now() - startedAt;
      if (code !== 0) {
        reject(new Error([
          `${suite.name} failed (code=${code}, signal=${signal ?? 'none'})`,
          output, errorOutput,
        ].filter(Boolean).join('\n')));
        return;
      }
      resolve(Object.freeze({
        name: suite.name,
        durationMs: Number(durationMs.toFixed(2)),
        output,
      }));
    });
  });
}

const runs = [];
for (let repeat = 1; repeat <= repeats; repeat += 1) {
  const startedAt = performance.now();
  const results = [];
  for (const suite of suites) results.push(await runSuite(suite));
  const durationMs = performance.now() - startedAt;
  assert.ok(durationMs < maximumRepeatMs,
    `Reliability repeat ${repeat} exceeded the five-minute gate timeout`);
  const completeCall = results.find((result) => result.name === 'complete_call');
  const replayReport = JSON.parse(completeCall.output.trim().split(/\r?\n/u).at(-1));
  assert.equal(replayReport.passed, true);
  assert.ok(replayReport.localReplayLatencyMs.p95 < 100,
    `Repeat ${repeat} complete-call p95 exceeded 100ms`);
  const latestCall = results.find((result) => result.name === 'latest_live_call');
  const latestCallReport = JSON.parse(latestCall.output.trim());
  assert.equal(latestCallReport.passed, true);
  assert.equal(latestCallReport.knownRequestLlmTimeouts, 0,
    `Repeat ${repeat}: a known latest-call request timed out in the LLM`);
  assert.equal(latestCallReport.genericClarificationsForValidStt, 0,
    `Repeat ${repeat}: valid STT received generic clarification`);
  assert.ok(latestCallReport.maximumFirstAudioMs
    < latestLiveCall.requirements.maximumFirstAudioMs,
  `Repeat ${repeat}: latest-call first audio exceeded two seconds`);
  runs.push(Object.freeze({
    repeat,
    durationMs: Number(durationMs.toFixed(2)),
    completeCallP95Ms: replayReport.localReplayLatencyMs.p95,
    latestCallFirstAudioMaxMs: latestCallReport.maximumFirstAudioMs,
    latestCallKnownRequestLlmTimeouts: latestCallReport.knownRequestLlmTimeouts,
    latestCallGenericClarifications: latestCallReport.genericClarificationsForValidStt,
    suites: Object.freeze(results.map(({ name, durationMs: suiteDurationMs }) => ({
      name, durationMs: suiteDurationMs,
    }))),
  }));
}

console.log(JSON.stringify({
  gate: 'realtime-reliability',
  passed: true,
  repeats,
  firstAudioDeadlineMs: env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS,
  completeCallP95LimitMs: 100,
  latestCallFirstAudioLimitMs: latestLiveCall.requirements.maximumFirstAudioMs,
  latestCallKnownRequestLlmTimeoutLimit: 0,
  requiredSuccessfulRuns: latestLiveCall.requirements.minimumSuccessfulRuns,
  suiteTimeoutMs,
  maximumRepeatMs,
  coverage: [
    'tamil_knowledge_engine', 'zero_runtime_exceptions', 'non_empty_known_evidence',
    'no_technical_fallback', 'latest_live_call', 'acknowledgement', 'Onco_STT_variations',
    'Kids', 'Silver', 'Gold', 'timing', 'complete_call',
    'Tamil', 'Tanglish', 'English', 'stt_variation',
    'topic_switching', 'comparison', 'safety', 'booking_confirmation',
    'verified_webhook', 'interruption', 'transcript_persistence',
    'tts_failure', 'five_minute_timeout', 'latency_thresholds',
    'zero_known_request_llm_timeouts', 'no_generic_clarification_for_valid_stt',
  ],
  runs,
}, null, 2));
