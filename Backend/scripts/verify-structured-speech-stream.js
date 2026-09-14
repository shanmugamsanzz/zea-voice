import assert from 'node:assert/strict';
import { createStructuredSpeechSentenceStream } from
  '../src/voice/interaction/structured-speech-stream.js';

const sentences = [];
const stream = createStructuredSpeechSentenceStream((sentence, details) => {
  sentences.push({ sentence, details });
});

for (const delta of [
  '{"outcome":"CONVERSATIONAL_RESPONSE","spe',
  'ech":"Hello \\u0BA8\\u0BA3',
  '\\u0BCD\\u0BAA\\u0BB0\\u0BC7. A quoted \\"value\\" is safe!',
]) stream.push(delta);

assert.deepEqual(sentences.map(({ sentence }) => sentence), [
  'Hello நண்பரே.',
  'A quoted "value" is safe!',
]);
assert.equal(stream.snapshot().complete, false);

stream.push(' Final fragment","workflowAction":null}');
assert.equal(stream.snapshot().complete, true);
assert.deepEqual(sentences.map(({ sentence }) => sentence), [
  'Hello நண்பரே.',
  'A quoted "value" is safe!',
  'Final fragment',
]);

const completed = stream.finish();
assert.equal(completed.complete, true);
assert.equal(completed.sentenceCount, 3);
assert.equal(sentences[2].sentence, 'Final fragment');
assert.equal(sentences[2].details.final, true);

const nested = [];
const nestedStream = createStructuredSpeechSentenceStream((sentence) => nested.push(sentence));
nestedStream.push('{"metadata":{"speech":"must not play"},"speech":"Allowed.",');
assert.deepEqual(nested, ['Allowed.']);
nestedStream.push('"workflowAction":null}');
nestedStream.finish();

console.log(JSON.stringify({
  suite: 'structured-speech-stream', passed: true, streamedSentences: sentences.length,
}));
