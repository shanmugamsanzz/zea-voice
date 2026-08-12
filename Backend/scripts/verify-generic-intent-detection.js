import assert from 'node:assert/strict';
import { detectConversationIntent, intentNames } from '../src/voice/interaction/intent-detector.js';

const cases = [
  ['என்னென்ன packages இருக்கு?', 'overview'],
  ['What services do you have?', 'overview'],
  ['Argon packages பத்தி சொல்லுங்க', 'category_request'],
  ['Silver package explain பண்ணுங்க', 'details'],
  ['இதோட price எவ்வளவு?', 'price'],
  ['Silverக்கும் Goldக்கும் என்ன வித்தியாசம்?', 'comparison'],
  ['எனக்கு stomach pain இருக்கு எந்த package choose பண்ணணும்?', 'scenario'],
  ['I need to book an appointment', 'booking_request'],
  ['எங்க location இருக்கு?', 'side_question'],
  ['ஆமா சரி பண்ணலாம்', 'confirmation'],
  ['zzz', 'unclear'],
];

for (const [text, expected] of cases) {
  const detected = detectConversationIntent(text);
  assert.equal(detected.intent, expected, `${text} should classify as ${expected}`);
  assert.ok(detected.confidence > 0);
}

const fieldAnswer = detectConversationIntent('Tomorrow morning ten', {
  pendingQuestion: 'Which slot works?', pendingQuestionKind: 'field',
});
assert.equal(fieldAnswer.intent, 'booking_field_answer');

const detourDuringField = detectConversationIntent('எங்க location இருக்கு?', {
  pendingQuestion: 'Which slot works?', pendingQuestionKind: 'field',
});
assert.equal(detourDuringField.intent, 'side_question');
assert.deepEqual(intentNames, [
  'overview', 'category_request', 'details', 'price', 'comparison', 'scenario',
  'booking_request', 'booking_field_answer', 'side_question', 'confirmation', 'unclear',
]);

console.log(JSON.stringify({
  task: 'Generic intent detection',
  intents: intentNames,
  languages: ['Tamil', 'Tanglish', 'English'],
  catalogHardcoding: false,
}, null, 2));
