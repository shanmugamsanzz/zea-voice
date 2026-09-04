import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  armTemplateEngineTurnLatencyAcknowledgement,
} from '../src/voice/interaction/template-engine-turn-latency.js';

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
  thresholdMs: 900,
  acknowledgementText: 'Configured progress speech.',
  isActive: () => true,
  onAcknowledgement: (text) => { spoken.push(text); return true; },
  onTriggered: (details) => triggered.push(details),
  setTimer: slowTimers.setTimer,
  clearTimer: slowTimers.clearTimer,
});
assert.equal(slowTimers.timers[0].delay, 900);
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
  thresholdMs: 900,
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
  thresholdMs: 900,
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

console.log('Template-engine whole-turn latency acknowledgement verification passed.');
