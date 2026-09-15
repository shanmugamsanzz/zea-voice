import assert from 'node:assert/strict';
import './verify-template-engine-operation-timing.js';
import { readFileSync } from 'node:fs';
import {
  armTemplateEngineTurnLatencyAcknowledgement,
  latencyAcknowledgementEligibleForRoute,
  resolveConfiguredLatencyAcknowledgement,
} from '../src/voice/interaction/template-engine-turn-latency.js';
import {
  recordTemplateEngineTurnMetrics,
  templateEngineAudioPercentiles,
} from '../src/voice/interaction/template-engine-observability.js';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    fire(timer) {
      if (timer.cleared) return;
      timer.cleared = true;
      timer.callback();
    },
  };
}

assert.equal(resolveConfiguredLatencyAcknowledgement({
  configuredText: 'Configured progress speech.',
}).text, 'Configured progress speech.',
'Latency acknowledgement must preserve the agent-configured caller-facing wording');
assert.equal(resolveConfiguredLatencyAcknowledgement({ configuredText: '' }).text, '',
  'Latency acknowledgement remains disabled without agent configuration');

assert.equal(latencyAcknowledgementEligibleForRoute({ decision: 'SEARCH' }), true);
for (const decision of ['RESPONSE', 'CLARIFY', 'TOOL', 'TOOL_RESULT']) {
  assert.equal(latencyAcknowledgementEligibleForRoute({ decision }), false,
    `${decision} must not receive latency acknowledgement speech`);
}
assert.equal(latencyAcknowledgementEligibleForRoute({
  decision: 'SEARCH', activeWorkflow: true,
}), true, 'A separate factual search may remain responsive while a workflow is paused');

const slowTimers = fakeTimers();
const spoken = [];
const triggered = [];
const slow = armTemplateEngineTurnLatencyAcknowledgement({
  thresholdMs: 750,
  acknowledgementText: 'Configured progress speech.',
  isActive: () => true,
  onAcknowledgement: (text) => { spoken.push(text); return true; },
  onTriggered: (details) => triggered.push(details),
  setTimer: slowTimers.setTimer,
  clearTimer: slowTimers.clearTimer,
});
assert.equal(slowTimers.timers[0].delay, 750);
slowTimers.fire(slowTimers.timers[0]);
slowTimers.fire(slowTimers.timers[0]);
assert.deepEqual(spoken, ['Configured progress speech.'],
  'A slow complete turn must queue its configured acknowledgement exactly once');
assert.equal(triggered.length, 1);
assert.equal(slow.snapshot().triggered, true);
assert.equal(slow.snapshot().queued, true);

const fastTimers = fakeTimers();
// Routing may finish after the acknowledgement deadline. Tool turns must stay
// quiet, while ordinary searches may release one deferred acknowledgement.
for (const release of [false, true]) {
  const clocks = fakeTimers();
  let count = 0;
  const controlled = armTemplateEngineTurnLatencyAcknowledgement({
    thresholdMs: 750, acknowledgementText: 'Configured progress speech.', suppressed: true,
    onAcknowledgement: () => { count += 1; return true; },
    setTimer: clocks.setTimer, clearTimer: clocks.clearTimer,
  });
  clocks.fire(clocks.timers[0]);
  assert.equal(count, 0);
  controlled.setSuppressed(!release);
  controlled.setSuppressed(!release);
  assert.equal(count, release ? 1 : 0);
  controlled.cancel();
  controlled.setSuppressed(false);
  assert.equal(count, release ? 1 : 0, 'Cancellation must prevent delayed acknowledgement');
}
let fastSpoken = false;
const fast = armTemplateEngineTurnLatencyAcknowledgement({
  thresholdMs: 750,
  acknowledgementText: 'Configured progress speech.',
  onAcknowledgement: () => { fastSpoken = true; return true; },
  setTimer: fastTimers.setTimer,
  clearTimer: fastTimers.clearTimer,
});
fast.cancel();
fastTimers.fire(fastTimers.timers[0]);
assert.equal(fastSpoken, false,
  'A final response ready before the threshold must cancel acknowledgement speech');

const staleTimers = fakeTimers();
let staleSpoken = false;
armTemplateEngineTurnLatencyAcknowledgement({
  thresholdMs: 750,
  acknowledgementText: 'Configured progress speech.',
  isActive: () => false,
  onAcknowledgement: () => { staleSpoken = true; return true; },
  setTimer: staleTimers.setTimer,
  clearTimer: staleTimers.clearTimer,
});
staleTimers.fire(staleTimers.timers[0]);
assert.equal(staleSpoken, false, 'A stale or finalized turn must not queue acknowledgement audio');

const orchestrator = readFileSync(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');
const liveReport = readFileSync(new URL(
  './build-production-latency-report.js', import.meta.url,
), 'utf8');
assert.match(orchestrator, /armTemplateEngineTurnLatencyAcknowledgement\(\{/u);
assert.match(orchestrator, /onTurnResolved:[\s\S]*latencyAcknowledgement\.setSuppressed/u);
assert.match(orchestrator, /runTemplateEngineProductionTurn\(\{/u);
assert.match(orchestrator, /finalResponseReady\s*=\s*true;[\s\S]*latencyAcknowledgement\.cancel\(\)/u,
  'The whole-turn timer must be cancelled as soon as the final result is ready');
assert.match(orchestrator, /sentencePipeline\.enqueueAcknowledgement\(text\)/u);
assert.match(orchestrator, /suppressed:\s*true/u,
  'Acknowledgement must remain suppressed until an eligible route is known');
assert.match(orchestrator, /latencyAcknowledgementEligibleForRoute/u);
assert.match(orchestrator,
  /finalResponseReady\s*=\s*true;[\s\S]*sentencePipeline\.cancelAcknowledgements\(\);[\s\S]*latencyAcknowledgement\.cancel\(\)/u,
  'A ready final answer must cancel both queued acknowledgement work and its timer');
assert.match(orchestrator, /template_engine\.turn_latency_acknowledgement/u);
for (const field of ['initialDecision', 'finalDecision', 'searchPerformed',
  'technicalRecoveryApplied', 'llmInvocationCount']) {
  assert.match(orchestrator, new RegExp(`${field}:`, 'u'),
    `Completed-turn telemetry must expose ${field} to the live release gate`);
}
assert.match(liveReport, /actualAnswerLatency:\s*\{/u,
  'Production reporting must retain raw actual-answer latency measurements');
assert.doesNotMatch(liveReport, /averageTargetMs|maximumTargetMs/u,
  'Production latency reporting must record measurements without fixed thresholds');
assert.match(liveReport, /multipleLlmInvocationTurns/u,
  'Live approval must reject every turn that exceeds the one-LLM ceiling');
assert.match(liveReport, /ordinaryStaticFallbackTurns/u,
  'Live approval must reject static recovery on ordinary turns');
assert.match(liveReport, /llmInvocationCount/u,
  'One-LLM evidence must be present in every completed-turn sample');
assert.match(liveReport, /incompleteTelemetryTurns/u,
  'Legacy or incomplete live logs must not satisfy the correctness gate');
assert.match(liveReport, /passed:\s*report\.liveCorrectness\.passed/u,
  'Live approval must retain correctness checks without a fixed latency gate');
assert.match(orchestrator, /templateEngineAcknowledgements\.triggered\s*\+=\s*1/u);
assert.match(orchestrator,
  /onSpeechSentence:[\s\S]*sentencePipeline\.enqueue\(sentence\)[\s\S]*finalResponseQueuedAt\s*\?\?=\s*Date\.now\(\)/u,
  'Each complete streamed speech sentence must enter TTS before the final result is ready');
assert.match(orchestrator,
  /streamedFinalSentenceCount\s*===\s*0\s*&&\s*!sentencePipeline\.enqueue\(finalAnswer\)/u,
  'Whole-answer enqueue must remain only as a non-streaming provider fallback');
assert.ok(orchestrator.indexOf('sentencePipeline.enqueue(finalAnswer)')
  < orchestrator.indexOf('const factualAnswerSources = templateEngineMessageSources(result'),
  'Source formatting must not delay fallback answer audio startup');
assert.match(orchestrator, /setLatencyAcknowledgementAudioCache/u,
  'The latency acknowledgement must use reusable cached audio');
assert.match(orchestrator, /latency_acknowledgement_audio_cache_hit/u);
assert.match(orchestrator, /generationPlaybackGroupId/u,
  'Latency acknowledgement and final response must use separate playback groups');

const metrics = {};
for (const [route, elapsedMs] of [['RESPONSE', 700], ['SEARCH', 1_700], ['TOOL', 900]]) {
  const sample = recordTemplateEngineTurnMetrics(metrics, {
    epoch: route,
    result: { provenance: { initialDecision: route, finalDecision: route } },
    turnStartedAt: 10_000,
    firstAudioAt: 10_000 + elapsedMs,
    finalResponseReadyAt: 10_000 + Math.max(1, elapsedMs - 200),
    firstFinalAudioAt: 10_000 + elapsedMs + 150,
  });
  assert.equal(sample.finalAnswerFirstAudioMs, elapsedMs + 150);
  assert.equal(sample.finalAnswerReadyMs, Math.max(1, elapsedMs - 200));
  assert.equal(sample.actualAnswerBaseline.normalVerifiedRequest, true);
  assert.equal(Object.hasOwn(sample, 'firstAudioTargetMs'), false);
  assert.equal(Object.hasOwn(sample.actualAnswerBaseline, 'maximumMs'), false);
}
const recoverySample = recordTemplateEngineTurnMetrics({}, {
  epoch: 'recovery-not-normal', result: { recoveryKind: 'operational' },
  turnStartedAt: 30_000, firstFinalAudioAt: 39_000,
});
assert.equal(recoverySample.normalVerifiedRequest, false);
assert.equal(recoverySample.actualAnswerBaseline.actualAnswerFirstAudioMs, 9_000);
const unexpectedFailureSample = recordTemplateEngineTurnMetrics({}, {
  epoch: 'unexpected-failure-not-normal', result: { unexpectedFailure: 'UNEXPECTED' },
  turnStartedAt: 30_000, firstFinalAudioAt: 39_000,
});
assert.equal(unexpectedFailureSample.normalVerifiedRequest, false);
const passingDistribution = templateEngineAudioPercentiles([
  ...Array.from({ length: 20 }, () => ({
    finalAnswerFirstAudioMs: 900, normalVerifiedRequest: true,
  })),
  { finalAnswerFirstAudioMs: 9_000, normalVerifiedRequest: false },
]);
assert.equal(passingDistribution.actualAnswerLatency.measured, 20,
  'Recovery audio must be excluded from normal answer latency measurements');
assert.equal(passingDistribution.actualAnswerLatency.averageMs, 900);
assert.equal(passingDistribution.actualAnswerLatency.maximumObservedMs, 900);
assert.equal(Object.hasOwn(passingDistribution.actualAnswerLatency, 'maximumTargetStatus'), false);

console.log('Template-engine whole-turn latency acknowledgement verification passed.');
