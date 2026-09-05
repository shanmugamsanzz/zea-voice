import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  armTemplateEngineTurnLatencyAcknowledgement,
} from '../src/voice/interaction/template-engine-turn-latency.js';
import {
  recordTemplateEngineTurnMetrics,
  templateEngineFirstAudioTargets,
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
assert.match(orchestrator, /armTemplateEngineTurnLatencyAcknowledgement\(\{/u);
assert.match(orchestrator, /runTemplateEngineProductionTurn\(\{/u);
assert.match(orchestrator, /finalResponseReady\s*=\s*true;[\s\S]*latencyAcknowledgement\.cancel\(\)/u,
  'The whole-turn timer must be cancelled as soon as the final result is ready');
assert.match(orchestrator, /sentencePipeline\.enqueueAcknowledgement\(text\)/u);
assert.match(orchestrator, /template_engine\.turn_latency_acknowledgement/u);
assert.match(orchestrator, /templateEngineAcknowledgements\.triggered\s*\+=\s*1/u);
assert.match(orchestrator, /setWorkflowFieldAudioCache\(result\.workflow\?\.speechCache/u,
  'A Workflow field turn must hand cached audio to the live sentence pipeline');
assert.match(orchestrator, /Buffer\.isBuffer\(reusableAudio\?\.audio\)/u,
  'Cached Workflow field audio must bypass live TTS synthesis');
assert.match(orchestrator, /capture:\s*capturedAudio/u,
  'A cache miss must capture generated field audio for later turns');
assert.match(orchestrator, /setLatencyAcknowledgementAudioCache/u,
  'The latency acknowledgement must use reusable cached audio');
assert.match(orchestrator, /latency_acknowledgement_audio_cache_hit/u);
assert.match(orchestrator, /generationPlaybackGroupId/u,
  'Latency acknowledgement and final response must use separate playback groups');

assert.deepEqual(templateEngineFirstAudioTargets, {
  RESPONSE: 1_000, CLARIFY: 1_000, SEARCH: 3_000, TOOL: 2_000,
});
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
}
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
