import assert from 'node:assert/strict';
import {
  buildPostCallSummaryMessages, normalizePostCallSummaryOutput,
} from '../src/voice/postcall-summary/postcall-summary-output.js';

const normalized = normalizePostCallSummaryOutput(`\`\`\`json
{
  "summary": "Customer asked about the Gold package.",
  "outcome": "information_provided",
  "customer_intent": "Compare packages",
  "sentiment": "positive",
  "collected_data": {"package": "Gold"},
  "follow_up_required": true,
  "follow_up_reason": "Customer requested package details"
}
\`\`\``);
assert.equal(normalized.summary, 'Customer asked about the Gold package.');
assert.equal(normalized.sentiment, 'positive');
assert.deepEqual(normalized.collectedData, { package: 'Gold' });
assert.equal(normalized.followUpRequired, true);

const noFollowUp = normalizePostCallSummaryOutput({
  summary: 'Call completed.', sentiment: 'unsupported', collected_data: [],
  follow_up_required: false, follow_up_reason: 'must be removed',
});
assert.equal(noFollowUp.sentiment, 'unknown');
assert.deepEqual(noFollowUp.collectedData, {});
assert.equal(noFollowUp.followUpReason, null);

assert.throws(() => normalizePostCallSummaryOutput('not JSON'), (error) => (
  error.code === 'POSTCALL_SUMMARY_OUTPUT_INVALID'
));

const messages = buildPostCallSummaryMessages({
  instructions: 'Capture package and appointment facts.',
  call: { direction: 'outbound' },
  transcript: [
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'Tell me about Gold.' },
  ],
}, { maximumTranscriptCharacters: 1000 });
assert.equal(messages.length, 2);
assert.match(messages[0].content, /exactly one valid JSON object/);
assert.match(messages[1].content, /ASSISTANT: Hello\./);
assert.match(messages[1].content, /USER: Tell me about Gold\./);

console.log('Post-Call structured summary output verification passed.');
