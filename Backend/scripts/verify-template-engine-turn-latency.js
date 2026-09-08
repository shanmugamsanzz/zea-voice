import assert from 'node:assert/strict';
import './verify-template-engine-operation-timing.js';
import { readFileSync } from 'node:fs';
import {
  armTemplateEngineTurnLatencyAcknowledgement,
  latencyAcknowledgementEligibleForRoute,
  resolveDynamicLatencyAcknowledgement,
} from '../src/voice/interaction/template-engine-turn-latency.js';
import {
  recordTemplateEngineTurnMetrics,
  templateEngineAudioPercentiles,
  templateEngineFirstAudioTargets,
  TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS,
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

const tamilComparison = resolveDynamicLatencyAcknowledgement({
  configuredText: 'Configured progress speech.',
  latestUtterance: 'Silverக்கும் Goldக்கும் என்ன வித்தியாசம்?',
  language: 'ta-IN',
  variantSeed: 1,
});
assert.equal(tamilComparison.requestKind, 'comparison');
assert.equal(tamilComparison.language, 'ta');
assert.ok(tamilComparison.text.includes('ஒப்பிட்டு') || tamilComparison.text.includes('வித்தியாச'));
assert.doesNotMatch(tamilComparison.text, /Silver|Gold/iu,
  'Latency speech must never repeat unverified business entities');

const englishPrice = resolveDynamicLatencyAcknowledgement({
  configuredText: 'Configured progress speech.',
  latestUtterance: 'How much does that cost?',
  language: 'en-US',
  variantSeed: 2,
});
assert.equal(englishPrice.requestKind, 'price');
assert.match(englishPrice.text, /price/iu);
assert.equal(resolveDynamicLatencyAcknowledgement({
  configuredText: '', latestUtterance: 'Tell me about it', language: 'en',
}).text, '', 'Dynamic acknowledgement remains disabled without approved configuration');
assert.equal(resolveDynamicLatencyAcknowledgement({
  configuredText: 'ஒரு நிமிடம்.', latestUtterance: 'जानकारी बताइए', language: 'hi-IN',
}).text, 'ஒரு நிமிடம்.',
'Languages without reviewed variants must preserve the configured caller-facing wording');

const firstVariant = resolveDynamicLatencyAcknowledgement({
  configuredText: 'Configured progress speech.', latestUtterance: 'Tell me the details',
  language: 'en', variantSeed: 0,
});
const secondVariant = resolveDynamicLatencyAcknowledgement({
  configuredText: 'Configured progress speech.', latestUtterance: 'Tell me the details',
  language: 'en', variantSeed: 1,
});
assert.notEqual(firstVariant.text, secondVariant.text,
  'Successive turns can use varied context-compatible acknowledgement wording');

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
for (const field of ['initialDecision', 'finalDecision', 'searchPerformed', 'validationResult',
  'evidenceCount', 'configuredFallbackApplied', 'entityCoverageComplete']) {
  assert.match(orchestrator, new RegExp(`${field}:`, 'u'),
    `Completed-turn telemetry must expose ${field} to the live release gate`);
}
assert.match(liveReport, /actualAnswerSamples\.length\s*>=\s*20/u);
assert.match(liveReport, /actualAnswerAverage\s*<\s*3_000/u);
assert.match(liveReport, /actualAnswerMaximum\s*<=\s*4_000/u);
assert.match(liveReport, /bookingFieldKnowledgeSearches/u);
assert.match(liveReport, /ungroundedSearchResponses/u);
assert.match(liveReport, /incorrectEntityResponses/u);
assert.match(liveReport, /incompleteTelemetryTurns/u,
  'Legacy or incomplete live logs must not satisfy the correctness gate');
assert.match(liveReport, /report\.actualAnswerSlo\.passed\s*&&\s*report\.liveCorrectness\.passed/u,
  'Live approval must require both latency and correctness');
assert.match(orchestrator, /templateEngineAcknowledgements\.triggered\s*\+=\s*1/u);
assert.match(orchestrator, /setWorkflowFieldAudioCache\(result\.workflow\?\.speechCache/u,
  'A Workflow field turn must hand cached audio to the live sentence pipeline');
assert.match(orchestrator, /Buffer\.isBuffer\(reusableAudio\?\.audio\)/u,
  'Cached Workflow field audio must bypass live TTS synthesis');
assert.match(orchestrator, /capture:\s*capturedAudio/u,
  'A cache miss must capture generated field audio for later turns');
assert.match(orchestrator,
  /finalResponseReadyAt\s*=\s*Date\.now\(\);[\s\S]*sentencePipeline\.enqueue\(finalAnswer\)[\s\S]*finalResponseQueuedAt\s*=\s*Date\.now\(\);[\s\S]*sentencePipeline\.waitUntilStarted\(\)/u,
  'Validated final speech must enter TTS immediately after the result becomes ready');
assert.ok(orchestrator.indexOf('sentencePipeline.enqueue(finalAnswer)')
  < orchestrator.indexOf('const factualAnswerSources = templateEngineMessageSources(result'),
  'Source formatting must not delay validated answer audio startup');
assert.match(orchestrator, /setLatencyAcknowledgementAudioCache/u,
  'The latency acknowledgement must use reusable cached audio');
assert.match(orchestrator, /latency_acknowledgement_audio_cache_hit/u);
assert.match(orchestrator, /generationPlaybackGroupId/u,
  'Latency acknowledgement and final response must use separate playback groups');

assert.deepEqual(templateEngineFirstAudioTargets, {
  RESPONSE: 1_000, CLARIFY: 1_000, SEARCH: 3_000, TOOL: 2_000,
});
assert.equal(TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS, 4_000);
const metrics = {};
for (const [route, elapsedMs] of [
  ['RESPONSE', 999], ['SEARCH', 2_999], ['TOOL', 1_999],
]) {
  const sample = recordTemplateEngineTurnMetrics(metrics, {
    epoch: route,
    result: { provenance: { initialDecision: route, finalDecision: route } },
    turnStartedAt: 10_000,
    firstAudioAt: 10_000 + elapsedMs,
    finalResponseReadyAt: 10_000 + Math.max(1, elapsedMs - 200),
    firstFinalAudioAt: 10_000 + elapsedMs + 150,
    firstAudioDeadlineMs: 9_999,
  });
  assert.equal(sample.firstAudioStatus, 'passed', `${route} must pass below its route target`);
  assert.equal(sample.firstAudioTargetMs, templateEngineFirstAudioTargets[route]);
  assert.equal(sample.finalAnswerFirstAudioMs, elapsedMs + 150);
  assert.equal(sample.finalAnswerReadyMs, Math.max(1, elapsedMs - 200));
  assert.equal(sample.actualAnswerBaseline.maximumMs, 4_000);
  assert.equal(sample.actualAnswerBaseline.normalVerifiedRequest, true);
}
const maximumBoundary = recordTemplateEngineTurnMetrics({}, {
  epoch: 'normal-maximum-boundary',
  result: { provenance: { initialDecision: 'SEARCH', finalDecision: 'RESPONSE' } },
  turnStartedAt: 30_000, firstFinalAudioAt: 34_000,
});
assert.equal(maximumBoundary.actualAnswerBaseline.maximumStatus, 'passed',
  'Four seconds is the inclusive maximum for a normal verified request');
const maximumBreach = recordTemplateEngineTurnMetrics({}, {
  epoch: 'normal-maximum-breach',
  result: { provenance: { initialDecision: 'SEARCH', finalDecision: 'RESPONSE' } },
  turnStartedAt: 30_000, firstFinalAudioAt: 34_001,
});
assert.equal(maximumBreach.actualAnswerBaseline.maximumStatus, 'missed');
const recoverySample = recordTemplateEngineTurnMetrics({}, {
  epoch: 'recovery-not-normal', result: { recoveryKind: 'validation' },
  turnStartedAt: 30_000, firstFinalAudioAt: 39_000,
});
assert.equal(recoverySample.normalVerifiedRequest, false);
assert.equal(recoverySample.actualAnswerBaseline.maximumStatus, 'not_measured',
  'Approved recovery timing must not be presented as a normal verified request sample');
const unexpectedFailureSample = recordTemplateEngineTurnMetrics({}, {
  epoch: 'unexpected-failure-not-normal', result: { unexpectedFailure: 'UNEXPECTED' },
  turnStartedAt: 30_000, firstFinalAudioAt: 39_000,
});
assert.equal(unexpectedFailureSample.normalVerifiedRequest, false);
const passingDistribution = templateEngineAudioPercentiles([
  ...Array.from({ length: 20 }, () => ({
    finalAnswerFirstAudioMs: 2_900, normalVerifiedRequest: true,
  })),
  { finalAnswerFirstAudioMs: 9_000, normalVerifiedRequest: false },
]);
assert.equal(passingDistribution.actualAnswerUnderThreeSeconds.averageTargetStatus, 'passed');
assert.equal(passingDistribution.actualAnswerUnderThreeSeconds.maximumTargetStatus, 'passed');
assert.equal(passingDistribution.actualAnswerUnderThreeSeconds.measured, 20,
  'Recovery audio must be excluded from the normal verified request SLO');
const maximumBreachDistribution = templateEngineAudioPercentiles([
  ...Array.from({ length: 19 }, () => ({
    finalAnswerFirstAudioMs: 2_900, normalVerifiedRequest: true,
  })),
  { finalAnswerFirstAudioMs: 4_001, normalVerifiedRequest: true },
]);
assert.equal(maximumBreachDistribution.actualAnswerUnderThreeSeconds.averageTargetStatus, 'passed');
assert.equal(maximumBreachDistribution.actualAnswerUnderThreeSeconds.maximumTargetStatus, 'missed',
  'A normal verified request above four seconds must fail even when the average is below target');
for (const route of ['RESPONSE', 'SEARCH', 'TOOL']) {
  const targetMs = templateEngineFirstAudioTargets[route];
  const sample = recordTemplateEngineTurnMetrics(metrics, {
    epoch: `${route}-boundary`,
    result: { provenance: { initialDecision: route, finalDecision: route } },
    turnStartedAt: 20_000,
    firstAudioAt: 20_000 + targetMs,
  });
  assert.equal(sample.firstAudioStatus, 'missed', `${route} target is strictly less than ${targetMs}ms`);
}

console.log('Template-engine whole-turn latency acknowledgement verification passed.');
