import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { normalizeTtsUsage } = await import('../src/voice/providers/tts/tts.interface.js');
const { normalizeAudioToAudioUsage } = await import('../src/voice/providers/audio-to-audio/audio-to-audio.interface.js');
const {
  calculateUsageCostLines, priceParameterKey, usageQuantityForParameter,
} = await import('../src/credits/usage-price-calculation.service.js');

assert.deepEqual(normalizeTtsUsage({ characters: 50, audioOutputMs: 2_500 }), {
  requests: 1, characters: 50, audioOutputMs: 2_500, audioBytes: 0,
  firstAudioLatencyMs: null, cost: null,
});
assert.deepEqual(normalizeAudioToAudioUsage({
  inputTokens: 20, outputTokens: 10, cachedInputTokens: 4,
  audioInputTokens: 60, audioOutputTokens: 30,
}), {
  audioInputBytes: 0, audioOutputBytes: 0, audioInputMs: 0, audioOutputMs: 0,
  inputTokens: 20, outputTokens: 10, cachedInputTokens: 4,
  audioInputTokens: 60, audioOutputTokens: 30, totalTokens: 0, requests: 1, cost: null,
});

const llmEvent = {
  serviceType: 'llm', inputTokens: 2_000_000, outputTokens: 500_000,
  cachedInputTokens: 1_000_000, audioInputTokens: 100_000, audioOutputTokens: 50_000, requests: 2,
};
const prices = [
  { id: 'input', parameterName: 'Input Tokens', currency: 'USD', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 2 },
  { id: 'output', parameterName: 'Output Tokens', currency: 'USD', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 4 },
  { id: 'cached', parameterName: 'Cached Input', currency: 'USD', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 0.5 },
  { id: 'audio-in', parameterName: 'Audio Input Tokens', currency: 'INR', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 10 },
  { id: 'audio-out', parameterName: 'Audio Output Tokens', currency: 'INR', unitName: '1 million tokens', unitQuantity: 1_000_000, price: 20 },
];
const calculated = calculateUsageCostLines(llmEvent, prices, [{ id: 'usd-rate', currency: 'USD', inrPerUnit: 80 }]);
assert.equal(calculated.lines.length, 5);
assert.equal(calculated.unpriced.length, 0);
assert.equal(calculated.lines.find((line) => line.parameterKey === 'input_tokens').costInr, 320);
assert.equal(calculated.lines.find((line) => line.parameterKey === 'output_tokens').costInr, 160);
assert.equal(calculated.lines.find((line) => line.parameterKey === 'cached_input_tokens').costInr, 40);
assert.equal(calculated.lines.find((line) => line.parameterKey === 'audio_input_tokens').costInr, 1);
assert.equal(calculated.lines.find((line) => line.parameterKey === 'audio_output_tokens').costInr, 1);
assert.equal(calculated.totalInr, 522);

const ttsEvent = { serviceType: 'tts', characters: 250, audioOutputMs: 90_000, requests: 1 };
assert.equal(usageQuantityForParameter(ttsEvent, 'generic_minutes'), 1.5);
const ttsCost = calculateUsageCostLines(ttsEvent, [
  { id: 'chars', parameterName: 'Characters', currency: 'INR', unitName: '100 characters', unitQuantity: 100, price: 2 },
  { id: 'seconds', parameterName: 'Seconds', currency: 'INR', unitName: 'per second', unitQuantity: 1, price: 0.1 },
  { id: 'requests', parameterName: 'Requests', currency: 'INR', unitName: 'per request', unitQuantity: 1, price: 1 },
]);
assert.equal(ttsCost.totalInr, 15);

assert.equal(priceParameterKey({ parameterName: 'Audio Input Tokens' }), 'audio_input_tokens');
assert.equal(priceParameterKey({ parameterName: 'Audio Output Minutes' }), 'output_minutes');
assert.equal(priceParameterKey({ parameterName: 'Unknown Meter' }), null);
const missingRate = calculateUsageCostLines(llmEvent, [prices[0]], []);
assert.equal(missingRate.lines.length, 0);
assert.equal(missingRate.unpriced[0].reason, 'exchange_rate_missing');

const [migration, completion, a2aRuntime] = await Promise.all([
  fs.readFile(new URL('../migrations/1788800000000_usage-price-calculation-engine.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/call-completion.service.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../src/voice/providers/audio-to-audio/realtime-websocket-runtime.js', import.meta.url), 'utf8'),
]);
assert.match(migration, /CREATE TABLE currency_exchange_rates/u);
assert.match(migration, /CREATE TABLE call_metered_usage_costs/u);
assert.match(migration, /usage_event_id, parameter_key/u);
assert.match(migration, /inr_exchange_rate/u);
assert.match(completion, /calculateAndPersistUsageEventCosts/u);
assert.match(a2aRuntime, /usageTracker\?\.record\?\.\('audio_to_audio'/u);

console.log(JSON.stringify({ success: true, task: 'TTS, audio-to-audio, and usage price calculation' }));
