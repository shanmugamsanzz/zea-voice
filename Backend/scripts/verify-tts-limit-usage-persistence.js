import assert from 'node:assert/strict';
import { normalizeTtsLimitUsage } from '../src/voice/tts-limit-usage.js';

assert.equal(normalizeTtsLimitUsage(null), null);

assert.deepEqual(normalizeTtsLimitUsage({
  maximumCharactersPerMinute: 0,
  maximumCallDurationMinutes: 0,
  charactersSynthesized: '75',
  currentWindowUsed: -10,
  throttleWaitMs: 0,
  durationLimitReached: false,
  providerCredential: 'must-not-persist',
}, { callDurationSeconds: 95.4 }), {
  maximumCharactersPerResponse: 0,
  maximumCharactersPerMinute: 0,
  maximumCallDurationMinutes: 0,
  charactersSynthesized: 75,
  currentWindowUsed: 0,
  throttleWaitMs: 0,
  characterLimitApplied: false,
  durationLimitReached: false,
  callDurationSeconds: 95,
});

const limited = normalizeTtsLimitUsage({
  maximumCharactersPerMinute: 1000,
  maximumCallDurationMinutes: 5,
  charactersSynthesized: 400,
  currentWindowUsed: 250,
  throttleWaitMs: 1200,
  durationLimitReached: true,
  arbitraryNestedData: { secret: true },
}, { callDurationSeconds: 300 });

assert.equal(limited.characterLimitApplied, true);
assert.equal(limited.durationLimitReached, true);
assert.equal(limited.callDurationSeconds, 300);
assert.equal(limited.arbitraryNestedData, undefined);

console.log(JSON.stringify({ success: true, task: 'TTS limit usage persistence normalization' }));
