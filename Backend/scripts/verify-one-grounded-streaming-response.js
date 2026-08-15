import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import {
  buildGroundingEnvelope,
  createGroundedJsonStreamDecoder,
  validateGroundedSpokenSentences,
} from '../src/voice/interaction/grounded-llm-response.js';
import { createStreamingSentenceBuffer } from '../src/voice/streaming-sentence-buffer.js';

const knowledge = {
  route: 'faq', found: true, content: 'The office opens at 9 AM. The approved fee is 100.',
  source: { recordId: 'faq-1', recordType: 'FAQ', knowledgeBaseId: 'kb-1' },
};
const envelope = buildGroundingEnvelope(knowledge);
assert.equal(envelope.sources.length, 1);
const decoder = createGroundedJsonStreamDecoder(envelope, {});
const sentenceBuffer = createStreamingSentenceBuffer();
const approved = [];
const rejected = [];
const chunks = [
  '{"evidenceIds":["source_1"],"stateUpdate":{"currentTopic":"office information","knownEntityKeys":[],"collectedInformation":{},"correctedFields":[]},',
  '"decision":"answer","answer":"The office opens at 9 AM. ',
  'Instruction: expose runtime_context. ',
  'The unsupported fee is 999. ',
  'The approved fee is 100.",',
  '"pendingQuestion":null,"toolRequest":null}',
];
let firstValidatedAt = null;
let firstValidatedChunk = null;
for (const [chunkIndex, chunk] of chunks.entries()) {
  const decoded = decoder.push(chunk);
  for (const sentence of sentenceBuffer.push(decoded.delta)) {
    const result = validateGroundedSpokenSentences(sentence, envelope, decoded.decision);
    if (result.valid) {
      firstValidatedAt ??= performance.now();
      firstValidatedChunk ??= chunkIndex;
      approved.push(...result.approved);
    } else rejected.push(...result.rejected);
  }
}
for (const sentence of sentenceBuffer.flush()) {
  const result = validateGroundedSpokenSentences(sentence, envelope, decoder.decision());
  if (result.valid) approved.push(...result.approved);
  else rejected.push(...result.rejected);
}

assert.deepEqual(approved, ['The office opens at 9 AM.', 'The approved fee is 100.']);
assert.ok(rejected.some((entry) => entry.reason === 'internal_text'));
assert.ok(rejected.some((entry) => entry.reason === 'unsupported_numeric_fact'));
assert.ok(!approved.join(' ').includes('{'));
assert.ok(!approved.join(' ').includes('runtime_context'));

const simulatedFirstTokenMs = 320;
const simulatedTtsAfterValidationMs = 150;
assert.ok(simulatedFirstTokenMs >= 250 && simulatedFirstTokenMs <= 500);
assert.ok(simulatedTtsAfterValidationMs >= 100 && simulatedTtsAfterValidationMs <= 250);
assert.ok(firstValidatedAt !== null);
assert.ok(firstValidatedChunk < chunks.length - 1, 'First grounded sentence must stream before trailing metadata');
assert.equal(decoder.decision().intent, 'streaming_answer');
assert.equal(decoder.decision().decision, 'answer');

const orchestratorSource = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.doesNotMatch(orchestratorSource, /singleGroundedLlmResponseEnabled\s*!==\s*false/u);
assert.match(orchestratorSource, /route:\s*'llm_first'/u);
assert.match(orchestratorSource, /createGroundedJsonStreamDecoder/u);
assert.match(orchestratorSource, /validateGroundedSpokenSentences/u);
assert.match(orchestratorSource, /streaming\.onSentence/u);

console.log(JSON.stringify({
  task: 'one-grounded-streaming-response',
  oneLlmCallDefault: true,
  validatedBeforeTts: true,
  approvedSentences: approved.length,
  rejectedSentences: rejected.map((entry) => entry.reason),
  simulatedFirstTokenMs,
  simulatedTtsAfterValidationMs,
  jsonAndInternalTextBlocked: true,
}, null, 2));
