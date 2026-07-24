import assert from 'node:assert/strict';
import {
  normalizeInterruptionSettings,
  resolveInterruptionConfiguration,
} from '../src/voice/interruption/interruption-config.js';
import { InterruptionCandidateManager } from '../src/voice/interruption/interruption-candidate-manager.js';

const normalized = normalizeInterruptionSettings({
  timeBasedInterruptionEnabled: true,
  interruptionSensitivityLabel: 'High (agent stops speaking instantly at any user sound)',
  wordBasedInterruptionEnabled: true,
  wordInterruptionMinWords: 9,
  wordInterruptionTriggerWords: [' stop ', 'one minute', 'stop'],
  interruptionPolicy: 'ALL',
});
assert.equal(normalized.wordInterruptionMinWords, 5);
assert.deepEqual(normalized.wordInterruptionTriggerWords, ['stop', 'one minute']);
assert.equal(normalized.interruptionPolicy, 'all');
assert.equal(resolveInterruptionConfiguration(normalized).timeBased.thresholdMs, 150);

const createCandidate = (configuration) => {
  let currentTime = 0;
  let timerCallback;
  const confirmations = [];
  const rejections = [];
  const manager = new InterruptionCandidateManager({
    configuration,
    now: () => currentTime,
    setTimer: (callback) => { timerCallback = callback; return { unref() {} }; },
    clearTimer: () => {},
    onConfirm: (details) => confirmations.push(details),
    onReject: (details) => rejections.push(details),
  });
  return {
    manager, confirmations, rejections,
    advance: (milliseconds) => { currentTime += milliseconds; },
    fireTimer: () => timerCallback?.(),
  };
};

const wordOnly = createCandidate(resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: false,
  wordBasedInterruptionEnabled: true,
  wordInterruptionMinWords: 2,
  interruptionPolicy: 'any',
}));
wordOnly.manager.start();
assert.equal(wordOnly.manager.observeTranscript('wait').confirmed, false);
assert.equal(wordOnly.manager.observeTranscript('wait please').confirmed, true);
assert.equal(wordOnly.confirmations.length, 1);

const tamil = createCandidate(resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: false,
  wordBasedInterruptionEnabled: true,
  wordInterruptionMinWords: 2,
}));
tamil.manager.start();
assert.equal(tamil.manager.observeTranscript('ஒரு நிமிடம்').confirmed, true);

const trigger = createCandidate(resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: false,
  wordBasedInterruptionEnabled: true,
  wordInterruptionMinWords: 5,
  wordInterruptionTriggerWords: ['one minute', 'stop'],
}));
trigger.manager.start();
const triggerDecision = trigger.manager.observeTranscript('One minute');
assert.equal(triggerDecision.confirmed, true);
assert.equal(triggerDecision.matchedTrigger, 'one minute');
assert.equal(triggerDecision.confirmedBy, 'trigger_word');

const all = createCandidate(resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: true,
  interruptionSensitivityLabel: 'Medium',
  wordBasedInterruptionEnabled: true,
  wordInterruptionMinWords: 2,
  interruptionPolicy: 'all',
}));
all.manager.start();
assert.equal(all.manager.observeTranscript('wait please').confirmed, false);
all.advance(350);
all.fireTimer();
assert.equal(all.manager.confirmed, true);
assert.equal(all.confirmations.length, 1);

const rejected = createCandidate(resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: false,
  wordBasedInterruptionEnabled: true,
  wordInterruptionMinWords: 3,
}));
rejected.manager.start();
rejected.manager.observeTranscript('hello');
rejected.manager.finish();
assert.equal(rejected.rejections.length, 1);

console.log(JSON.stringify({ success: true, task: 'Interruption settings and policy' }));

