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
const expectedBehaviors = new Set(fixture.turns.map((turn) => turn.expect));
for (const behavior of [
  'contextual_response', 'tenant_entity', 'stt_tenant_entity', 'tenant_category',
  'topic_change', 'comparison', 'safety', 'configured_action',
]) assert.ok(expectedBehaviors.has(behavior), `Complete-call fixture is missing ${behavior}`);
const actionTurn = fixture.turns.find((turn) => turn.expect === 'configured_action');
assert.equal(actionTurn?.requiresConfirmation, true);
assert.equal(actionTurn?.requiresVerifiedSuccess, true);
assert.equal(configuredCallDurationMs(5), 300_000,
  'A configured five-minute call limit must arm exactly at five minutes');
assert.equal(configuredCallDurationMs(0), null);
assert.equal(env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000);
assert.ok(env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);

const suites = Object.freeze([
  { name: 'exact_live_call_2026_08_24', file: 'verify-exact-live-call-regression.js' },
  { name: 'plivo_hangup_cause', file: 'verify-plivo-hangup-cause-logging.js' },
  { name: 'knowledge_engine_acceptance', file: 'verify-knowledge-engine-acceptance.js' },
  { name: 'tamil_knowledge_engine', file: 'verify-tamil-live-call-knowledge-engine.js' },
  { name: 'tenant_variations', file: 'verify-tenant-regression-generator.js' },
  { name: 'entity_routing', file: 'verify-universal-entity-routing.js' },
  { name: 'grounded_turn', file: 'verify-unified-grounded-turn.js' },
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
  const engineAcceptance = results.find((result) => result.name === 'knowledge_engine_acceptance');
  const engineAcceptanceReport = JSON.parse(engineAcceptance.output.trim());
  assert.equal(engineAcceptanceReport.passed, true);
  assert.equal(engineAcceptanceReport.metrics.runtimeErrors, 0);
  assert.equal(engineAcceptanceReport.metrics.falseClarifications, 0);
  const exactLiveCall = results.find((result) => result.name === 'exact_live_call_2026_08_24');
  const exactLiveCallReport = JSON.parse(exactLiveCall.output.trim());
  assert.equal(exactLiveCallReport.passed, true);
  assert.equal(exactLiveCallReport.runtimeExceptions, 0);
  assert.equal(exactLiveCallReport.callsPerPass, 2);
  assert.equal(exactLiveCallReport.falseAmbiguities, 0);
  assert.equal(exactLiveCallReport.groundingRejections, 0);
  assert.equal(exactLiveCallReport.audioUnderruns, 0);
  assert.equal(exactLiveCallReport.ttsSentenceFailures, 0);
  assert.ok(exactLiveCallReport.retrievalP95Ms < 150,
    `Repeat ${repeat}: exact live-call retrieval exceeded 150ms`);
  assert.ok(exactLiveCallReport.firstAudioP95Ms < 2_000,
    `Repeat ${repeat}: exact live-call first audio exceeded two seconds`);
  runs.push(Object.freeze({
    repeat,
    durationMs: Number(durationMs.toFixed(2)),
    knowledgeEngineRetrievalP95Ms: engineAcceptanceReport.metrics.retrievalP95Ms,
    exactLiveCallRetrievalP95Ms: exactLiveCallReport.retrievalP95Ms,
    exactLiveCallFirstAudioP95Ms: exactLiveCallReport.firstAudioP95Ms,
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
  knowledgeEngineRetrievalLimitMs: 150,
  exactLiveCallFirstAudioLimitMs: 2_000,
  exactLiveCallRetrievalLimitMs: 150,
  requiredSuccessfulRuns: minimumRepeats,
  suiteTimeoutMs,
  maximumRepeatMs,
  coverage: [
    'tamil_knowledge_engine', 'zero_runtime_exceptions', 'non_empty_known_evidence',
    'no_technical_fallback', 'acknowledgement', 'Onco_STT_variations',
    'Kids', 'Silver', 'Gold', 'timing', 'knowledge_engine_acceptance',
    'Tamil', 'Tanglish', 'English', 'stt_variation',
    'topic_switching', 'comparison', 'safety', 'booking_confirmation',
    'verified_webhook', 'interruption', 'transcript_persistence',
    'tts_failure', 'five_minute_timeout', 'latency_thresholds',
    'zero_known_request_llm_timeouts', 'no_generic_clarification_for_valid_stt',
    'exact_live_call_2026_08_24', 'full_evidence_validation', 'tenant_driven_phonetic_response',
    'structured_plivo_hangup_cause', 'two_isolated_live_calls',
    'source_id_mapping', 'call_memory_follow_up', 'zero_audio_underruns',
  ],
  runs,
}, null, 2));
