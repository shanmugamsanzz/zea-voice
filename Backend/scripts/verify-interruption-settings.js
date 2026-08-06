import assert from 'node:assert/strict';
import {
  normalizeInterruptionSettings,
  resolveInterruptionConfiguration,
} from '../src/voice/interruption/interruption-config.js';
import { InterruptionCandidateManager } from '../src/voice/interruption/interruption-candidate-manager.js';
import { CustomerUtteranceBuffer } from '../src/voice/interruption/customer-utterance-buffer.js';
import { validateFinalCustomerTurn } from '../src/voice/interruption/final-turn-validator.js';

const normalized = normalizeInterruptionSettings({
  timeBasedInterruptionEnabled: true,
  interruptionSensitivityLabel: 'High (legacy setting)',
  wordInterruptionMinWords: 9,
  wordInterruptionTriggerWords: [' stop ', 'one minute', 'stop'],
});
assert.equal(normalized.speechConfirmationDelayMs, 150, 'Legacy sensitivity must map to a delay');
assert.equal(normalized.minimumMeaningfulWords, 3, 'Minimum meaningful words must be bounded');
assert.deepEqual(normalized.explicitStopPhrases, ['stop', 'one minute']);

const configured = resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: true,
  speechConfirmationDelayMs: 350,
  minimumMeaningfulWords: 2,
  acknowledgementPhrases: [' ம் ', 'ok', 'ok'],
  explicitStopPhrases: [' wait ', 'stop'],
});
assert.equal(configured.timeBased.thresholdMs, 350);
assert.equal(configured.wordBased.minimumWords, 2);
assert.deepEqual(configured.acknowledgementPhrases, ['ம்', 'ok']);
assert.deepEqual(configured.explicitStopPhrases, ['wait', 'stop']);

const createCandidate = (configuration) => {
  let currentTime = 0;
  let timerCallback;
  const confirmations = [];
  const manager = new InterruptionCandidateManager({
    configuration,
    now: () => currentTime,
    setTimer: (callback) => { timerCallback = callback; return { unref() {} }; },
    clearTimer: () => {},
    onConfirm: (details) => confirmations.push(details),
  });
  return {
    manager, confirmations,
    advance: (milliseconds) => { currentTime += milliseconds; },
    fireTimer: () => timerCallback?.(),
  };
};

const candidate = createCandidate(configured);
candidate.manager.start();
candidate.advance(350);
candidate.fireTimer();
assert.equal(candidate.confirmations.length, 0, 'Sound/timer alone must never interrupt');

const firstWord = candidate.manager.observeTranscript('hello');
assert.equal(firstWord.confirmed, false, 'One word must not satisfy a two-word setting');
const meaningful = candidate.manager.observeTranscript('hello please');
assert.equal(meaningful.confirmed, true, 'Confirmed meaningful text after the delay must interrupt');
assert.equal(candidate.confirmations.length, 1);

const acknowledgement = createCandidate(configured);
acknowledgement.manager.start();
acknowledgement.advance(350);
const acknowledgementDecision = acknowledgement.manager.observeTranscript('ok');
assert.equal(acknowledgementDecision.classification, 'acknowledgement');
assert.equal(acknowledgementDecision.confirmed, false, 'Acknowledgements must not interrupt active agent audio');

const explicitStop = createCandidate(configured);
explicitStop.manager.start();
const stopDecision = explicitStop.manager.observeTranscript('wait');
assert.equal(stopDecision.classification, 'explicit_stop');
assert.equal(stopDecision.stopPhraseOnly, true);
assert.equal(stopDecision.confirmed, true, 'STT-confirmed stop phrase must interrupt without waiting for the delay');
assert.equal(stopDecision.confirmedBy, 'explicit_stop_phrase');

const utterance = new CustomerUtteranceBuffer();
utterance.start();
utterance.observePartial('எனக்கு வந்து');
utterance.observePartial('எனக்கு வந்து cardiac health பத்தி');
utterance.observeFinal('எனக்கு வந்து cardiac health பத்தி சொல்லுங்க');
assert.equal(utterance.ready, false, 'A final transcript must wait for speech_ended');
utterance.markSpeechEnded();
assert.equal(utterance.ready, true, 'A final transcript becomes processable only after speech_ended');
assert.equal(utterance.text, 'எனக்கு வந்து cardiac health பத்தி சொல்லுங்க', 'Cumulative STT partials must become one complete turn');

const incrementalUtterance = new CustomerUtteranceBuffer();
incrementalUtterance.start();
incrementalUtterance.observePartial('எனக்கு வந்து');
incrementalUtterance.observePartial('cardiac health பத்தி சொல்லுங்க');
incrementalUtterance.observeFinal('cardiac health பத்தி சொல்லுங்க');
assert.equal(incrementalUtterance.text, 'எனக்கு வந்து cardiac health பத்தி சொல்லுங்க', 'Incremental STT partials must append without duplicate text');

assert.equal(validateFinalCustomerTurn({ text: 'எனக்கு வந்து', minimumWords: 2 }).reason, 'incomplete');
assert.equal(validateFinalCustomerTurn({ text: 'cardiac health பத்தி சொல்லுங்க', confidence: 0.2, minimumWords: 2 }).reason, 'low_confidence');
assert.equal(validateFinalCustomerTurn({ text: 'cardiac health பத்தி சொல்லுங்க', confidence: null, minimumWords: 2 }).accepted, true);

const delayed = createCandidate(resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: true,
  speechConfirmationDelayMs: 350,
  minimumMeaningfulWords: 2,
}));
delayed.manager.start();
assert.equal(delayed.manager.observeTranscript('hello please').confirmed, false);
delayed.advance(350);
delayed.fireTimer();
assert.equal(delayed.manager.confirmed, true, 'Meaningful transcript must wait for confirmation delay');

console.log(JSON.stringify({ success: true, task: 'Transcript-confirmed interruption settings' }));
