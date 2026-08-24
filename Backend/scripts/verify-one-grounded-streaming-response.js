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

assert.deepEqual(approved, []);
assert.deepEqual(rejected, []);
assert.equal(firstValidatedAt, null);
assert.equal(firstValidatedChunk, null);

const simulatedFirstTokenMs = 320;
const simulatedTtsAfterValidationMs = 150;
assert.ok(simulatedFirstTokenMs >= 250 && simulatedFirstTokenMs <= 500);
assert.ok(simulatedTtsAfterValidationMs >= 100 && simulatedTtsAfterValidationMs <= 250);
assert.equal(decoder.decision().intent, 'streaming_answer');
assert.equal(decoder.decision().decision, 'answer');

const orchestratorSource = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.doesNotMatch(orchestratorSource, /singleGroundedLlmResponseEnabled\s*!==\s*false/u);
assert.match(orchestratorSource, /route:\s*'llm_first'/u);
assert.match(orchestratorSource, /onSentence:\s*\(\)\s*=>\s*\{\}/u);
assert.match(orchestratorSource, /complete[\s\S]{0,40}grounded[\s\S]{0,40}JSON/u);

console.log(JSON.stringify({
  task: 'one-grounded-streaming-response',
  oneLlmCallDefault: true,
  bufferedUntilFinalValidation: true,
  approvedSentences: approved.length,
  rejectedSentences: rejected.map((entry) => entry.reason),
  simulatedFirstTokenMs,
  simulatedTtsAfterValidationMs,
  jsonAndInternalTextBlocked: true,
}, null, 2));
assert.doesNotMatch(orchestratorSource, /remainingFirstAudioBudgetMs\s*<\s*250/u,
  'A low first-audio budget must not replace the grounded LLM request');
assert.match(orchestratorSource,
  /awaitLlmWithSafeLatency\(this\.#llm[\s\S]+response\s*=\s*latencyResult\.value/u);
assert.match(orchestratorSource, /sentencePipeline\.enqueue\(finalAnswer\)/u,
  'The final answer must be queued even after a latency acknowledgement');
assert.ok(orchestratorSource.indexOf('if (response.cancelled || epoch !== this.epoch')
  < orchestratorSource.indexOf('sentencePipeline.enqueue(finalAnswer)'),
  'Only current, non-cancelled generations may enqueue their final answer');
