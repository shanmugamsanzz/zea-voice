import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTtsTextPreprocessor } from '../src/voice/tts-text-preprocessor.js';
import { streamSelectedTtsToPlivo } from '../src/voice/providers/tts/tts-playback.service.js';

const processor = createTtsTextPreprocessor({
  language: 'en-IN',
  timeZone: 'Asia/Kolkata',
  context: { customer_name: 'Shanmugam', nested: { package: 'Gold' } },
  now: () => new Date('2026-07-28T06:30:00.000Z'),
});

const prepared = processor.process(
  'Hello {{customer_name}}. Today is ${currentDate} at ${currentTime}. Package: {{nested.package}}. ₹4,950 and 30%.',
);
assert.equal(prepared.unresolvedVariables.length, 0);
assert.deepEqual(prepared.resolvedVariables,
  ['customer_name', 'currentDate', 'currentTime', 'nested.package']);
assert.doesNotMatch(prepared.text, /{{|\$\{/);
assert.match(prepared.text, /Shanmugam/);
assert.match(prepared.text, /(?:28 July|July 28),? 2026/);
assert.match(prepared.text, /4950 rupees/);
assert.match(prepared.text, /30 percent/);

const blocked = processor.process('Use {{missing_value}} and ${system.secret}. **Continue safely.**');
assert.deepEqual(blocked.unresolvedVariables, ['missing_value', 'system.secret']);
assert.doesNotMatch(blocked.text, /{{|\$\{|missing_value|system\.secret|\*\*/);
assert.match(blocked.text, /Continue safely/);

const injected = createTtsTextPreprocessor({
  context: { customer_name: '<speak>Bad {{secret}}</speak>' },
}).process('Hello {{customer_name}}');
assert.doesNotMatch(injected.text, /<|>|{{|}}/);

let synthesizedText;
const adapter = {
  async connect() {},
  async *synthesizeStream(input) {
    synthesizedText = input.text;
    yield { type: 'audio_chunk', audio: Buffer.alloc(160), generationId: input.generationId };
    yield { type: 'completed', usage: {}, generationId: input.generationId };
  },
  cancel() { return false; },
  async close() {},
};
const audioEngine = {
  beginOutputGeneration() {},
  async enqueueSynthesized() { return true; },
  async flushSynthesized() { return true; },
  cancelStaleAudio() {},
};
await streamSelectedTtsToPlivo({
  agent: { language: 'en-IN', settings: { timezone: 'Asia/Kolkata' } },
  providers: { tts: { providerId: 'tts', modelId: 'model' } },
}, 'Booking date is ${currentDate} for {{customer_name}}.', {
  adapter, audioEngine, generationId: 'prepared-1',
  templateContext: { customer_name: 'Shanmugam' },
  textProcessor: processor,
});
assert.doesNotMatch(synthesizedText, /{{|\$\{/);
assert.match(synthesizedText, /Shanmugam/);
assert.match(synthesizedText, /(?:28 July|July 28),? 2026/);

const benchmarkStart = performance.now();
for (let index = 0; index < 10_000; index += 1) {
  processor.process('Hello {{customer_name}}. Today is ${currentDate}.');
}
const averagePreparationMs = (performance.now() - benchmarkStart) / 10_000;
assert.ok(averagePreparationMs < 1, `TTS preparation was unexpectedly slow: ${averagePreparationMs}ms average`);

console.log(`TTS text preparation verification passed (${averagePreparationMs.toFixed(4)}ms average).`);
