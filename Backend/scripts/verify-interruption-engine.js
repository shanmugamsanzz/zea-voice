import assert from 'node:assert/strict';
import { InterruptionCandidateManager } from '../src/voice/interruption/interruption-candidate-manager.js';
import { resolveInterruptionConfiguration } from '../src/voice/interruption/interruption-config.js';
import { CustomerUtteranceBuffer } from '../src/voice/interruption/customer-utterance-buffer.js';
import { validateFinalCustomerTurn } from '../src/voice/interruption/final-turn-validator.js';
import { ShortTurnMerger } from '../src/voice/interruption/short-turn-merger.js';

function createCandidate(configuration) {
  let now = 0;
  let timer = null;
  const confirmations = [];
  const manager = new InterruptionCandidateManager({
    configuration,
    now: () => now,
    setTimer: (callback) => { timer = callback; return { unref() {} }; },
    clearTimer: () => { timer = null; },
    onConfirm: (decision) => confirmations.push(decision),
  });
  return {
    manager,
    confirmations,
    advance: (milliseconds) => { now += milliseconds; },
    fireTimer: () => timer?.(),
  };
}

const configuration = resolveInterruptionConfiguration({
  timeBasedInterruptionEnabled: true,
  speechConfirmationDelayMs: 350,
  minimumMeaningfulWords: 2,
  acknowledgementPhrases: ['ம்', 'hmm', 'ok', 'seri'],
  explicitStopPhrases: ['ஒரு நிமிஷம்', 'wait', 'stop'],
});

// Noise / empty STT must never interrupt merely because time passes.
const noise = createCandidate(configuration);
noise.manager.start();
noise.advance(350);
noise.fireTimer();
assert.equal(noise.confirmations.length, 0);
assert.equal(noise.manager.observeTranscript('').classification, 'empty');

// Tamil and Tanglish acknowledgements keep agent speech running.
for (const acknowledgementText of ['ம்', 'hmm', 'seri']) {
  const acknowledgement = createCandidate(configuration);
  acknowledgement.manager.start();
  acknowledgement.advance(350);
  const result = acknowledgement.manager.observeTranscript(acknowledgementText);
  assert.equal(result.classification, 'acknowledgement');
  assert.equal(result.confirmed, false);
}

// Explicit English and Tamil stop phrases are confirmed only after STT text exists.
for (const stopText of ['wait', 'ஒரு நிமிஷம்']) {
  const stop = createCandidate(configuration);
  stop.manager.start();
  const result = stop.manager.observeTranscript(stopText);
  assert.equal(result.classification, 'explicit_stop');
  assert.equal(result.confirmed, true);
}

// Meaningful Tamil, Tanglish and English turns need the confirmation delay.
for (const customerText of [
  'எனக்கு cardiac health பற்றி சொல்லுங்க',
  'cardiac package pathi sollunga',
  'Please explain the silver package',
]) {
  const candidate = createCandidate(configuration);
  candidate.manager.start();
  assert.equal(candidate.manager.observeTranscript(customerText).confirmed, false);
  candidate.advance(350);
  candidate.fireTimer();
  assert.equal(candidate.confirmations.length, 1);
  assert.equal(validateFinalCustomerTurn({ text: customerText, minimumWords: 2 }).accepted, true);
}

assert.equal(validateFinalCustomerTurn({ text: 'எனக்கு வந்து', minimumWords: 2 }).reason, 'incomplete');
assert.equal(validateFinalCustomerTurn({ text: 'hmm', minimumWords: 2 }).accepted, true,
  'provider-finalized short speech must reach generic meaning resolution');
for (const acknowledgement of ['சரி', 'okay', 'yes']) {
  const result = validateFinalCustomerTurn({
    text: acknowledgement, minimumWords: 3,
    acknowledgementPhrases: [acknowledgement], rejectAcknowledgement: false,
  });
  assert.equal(result.accepted, true, `configured short acknowledgement must be accepted: ${acknowledgement}`);
  assert.equal(result.shortMeaningfulTurn, true);
}
assert.equal(validateFinalCustomerTurn({
  text: 'price?', minimumWords: 3, acknowledgementPhrases: [],
}).accepted, true, 'a finalized one-word question must not be rejected by word count');
assert.equal(validateFinalCustomerTurn({
  text: 'yes', confidence: 0.2, minimumWords: 3, acknowledgementPhrases: ['yes'],
}).reason, 'low_confidence', 'low-confidence short speech remains rejected');

// Several STT partials must become one final request, once only.
const buffer = new CustomerUtteranceBuffer();
buffer.start();
buffer.observePartial('எனக்கு வந்து');
buffer.observePartial('எனக்கு வந்து cardiac package பற்றி');
buffer.observePartial('எனக்கு வந்து cardiac package பற்றி சொல்லுங்க');
buffer.observeFinal('எனக்கு வந்து cardiac package பற்றி சொல்லுங்க');
buffer.markSpeechEnded();
assert.equal(buffer.ready, true);
assert.equal(buffer.finalConfidence, null, 'Missing provider confidence must remain unknown, not become zero');
assert.equal(buffer.markFinalProcessed(), true);
assert.equal(buffer.markFinalProcessed(), false, 'Repeated final STT events must not create a second customer turn');
assert.equal(buffer.text, 'எனக்கு வந்து cardiac package பற்றி சொல்லுங்க');

// Provider-finalized micro-fragments are joined only during a short window;
// they are not streamed frame-by-frame to the LLM.
let mergeNow = 0;
const merger = new ShortTurnMerger({ windowMs: 1200, now: () => mergeNow });
merger.defer('silver package');
mergeNow = 700;
assert.equal(merger.combine('price sollunga'), 'silver package price sollunga');
merger.defer('configured ser');
mergeNow = 900;
assert.equal(merger.combine('service details'), 'configured service details',
  'Overlapping provider-finalized fragments must assemble without duplicated text');
merger.defer('old fragment');
mergeNow = 2200;
assert.equal(merger.combine('new question'), 'new question');

console.log(JSON.stringify({
  success: true,
  task: 'Race-safe interruption call-level scenarios',
  scenarios: ['Tamil', 'Tanglish', 'English', 'noise', 'acknowledgement', 'stop_phrase', 'incomplete', 'repeated_interruption'],
}));
