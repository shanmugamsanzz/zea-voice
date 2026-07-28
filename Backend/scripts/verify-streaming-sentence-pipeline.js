import assert from 'node:assert/strict';
import { createStreamingSentenceBuffer } from '../src/voice/streaming-sentence-buffer.js';

const fragmented = createStreamingSentenceBuffer();
assert.deepEqual(fragmented.push('வணக்கம். உங்களுக்கு '), ['வணக்கம்.']);
assert.deepEqual(fragmented.push('எப்படி உதவலாம்? இன்னும்'), ['உங்களுக்கு எப்படி உதவலாம்?']);
assert.deepEqual(fragmented.flush(), ['இன்னும்']);

const decimals = createStreamingSentenceBuffer();
assert.deepEqual(decimals.push('The price is 4.'), []);
assert.deepEqual(decimals.push('95 rupees. Next sentence!'),
  ['The price is 4.95 rupees.', 'Next sentence!']);

const abbreviation = createStreamingSentenceBuffer();
assert.deepEqual(abbreviation.push('Dr. Kumar is available. Please wait.'),
  ['Dr. Kumar is available.', 'Please wait.']);

const incomplete = createStreamingSentenceBuffer();
assert.deepEqual(incomplete.push('Never speak this incomplete fragment'), []);
assert.deepEqual(incomplete.flush(), ['Never speak this incomplete fragment']);

console.log(JSON.stringify({ success: true, task: 'Complete LLM sentence streaming pipeline' }));
