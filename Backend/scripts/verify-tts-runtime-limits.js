import assert from 'node:assert/strict';
import {
  completeSentencePrefix,
  spokenCharacterCount,
  TtsCharacterBudget,
} from '../src/voice/tts-character-budget.js';

let now = 1_000;
const budget = new TtsCharacterBudget(100, { now: () => now });
assert.equal(spokenCharacterCount('😀'), 1);
assert.equal(budget.enabled, true);

const longMessage = `${'A'.repeat(55)}. ${'B'.repeat(55)}.`;
const fitted = budget.fitMessage(longMessage, 'Please ask one question at a time.');
assert.equal(fitted, `${'A'.repeat(55)}.`);
assert.ok(spokenCharacterCount(fitted) <= 100);

const first = budget.consume('A'.repeat(60));
assert.equal(first.allowed, true);
assert.equal(first.used, 60);
const blocked = budget.inspect('B'.repeat(50));
assert.equal(blocked.allowed, false);
assert.equal(blocked.waitMs, 60_000);

now += 60_000;
const second = budget.consume('B'.repeat(50));
assert.equal(second.allowed, true);
assert.equal(second.used, 50);

const unlimited = new TtsCharacterBudget(0);
assert.equal(unlimited.consume('C'.repeat(20_000)).allowed, true);
assert.equal(unlimited.usage().remaining, null);

const tamilAnswer = 'சில்வர் பேக்கேஜ் அடிப்படை பரிசோதனைகளை கொண்டுள்ளது. கோல்டு பேக்கேஜில் கூடுதல் பரிசோதனைகள் உள்ளன.';
const tamilFirstSentence = 'சில்வர் பேக்கேஜ் அடிப்படை பரிசோதனைகளை கொண்டுள்ளது.';
assert.equal(completeSentencePrefix(tamilAnswer, Array.from(tamilFirstSentence).length, 'ta'), tamilFirstSentence);
assert.equal(unlimited.fitMessage(tamilAnswer, 'சுருக்கமாகச் சொல்கிறேன்.', {
  maximumCharacters: Array.from(tamilFirstSentence).length,
  locale: 'ta',
}), tamilFirstSentence);
assert.equal(unlimited.fitMessage('A'.repeat(80), 'Please ask again.', {
  maximumCharacters: 50,
  locale: 'en',
}), 'Please ask again.');

console.log(JSON.stringify({ success: true, task: 'Rolling TTS character budget' }));
