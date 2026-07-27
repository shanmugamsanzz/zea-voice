import assert from 'node:assert/strict';
import {
  normalizeTtsUsageLimitSettings,
  ttsUsageLimitDefaults,
} from '../src/voice/tts-usage-limit-config.js';

assert.deepEqual(normalizeTtsUsageLimitSettings({}), ttsUsageLimitDefaults);
assert.deepEqual(normalizeTtsUsageLimitSettings({
  ttsMaxCharactersPerResponse: 300,
  ttsMaxCharactersPerMinute: 1000,
  maxCallDurationMinutes: 5,
  ttsLimitFallbackMessage: 'Please ask me again.',
  unrelatedSetting: true,
}), {
  ttsMaxCharactersPerResponse: 300,
  ttsMaxCharactersPerMinute: 1000,
  maxCallDurationMinutes: 5,
  ttsLimitFallbackMessage: 'Please ask me again.',
  unrelatedSetting: true,
});
assert.throws(
  () => normalizeTtsUsageLimitSettings({ ttsMaxCharactersPerResponse: 49, ttsLimitFallbackMessage: 'Please retry.' }),
  (error) => error.code === 'VOICE_TTS_USAGE_LIMIT_INVALID'
    && error.field === 'settings.ttsMaxCharactersPerResponse',
);
assert.throws(
  () => normalizeTtsUsageLimitSettings({ ttsMaxCharactersPerResponse: 100 }),
  (error) => error.field === 'settings.ttsLimitFallbackMessage',
);
assert.throws(
  () => normalizeTtsUsageLimitSettings({ ttsMaxCharactersPerResponse: 50, ttsLimitFallbackMessage: 'Incomplete' }),
  /sentence punctuation/,
);
assert.throws(
  () => normalizeTtsUsageLimitSettings({
    ttsMaxCharactersPerResponse: 300,
    ttsMaxCharactersPerMinute: 100,
    ttsLimitFallbackMessage: `${'A'.repeat(100)}.`,
  }),
  /effective response character limit/,
);
assert.throws(
  () => normalizeTtsUsageLimitSettings({ ttsMaxCharactersPerMinute: 99 }),
  (error) => error.code === 'VOICE_TTS_USAGE_LIMIT_INVALID'
    && error.field === 'settings.ttsMaxCharactersPerMinute',
);
assert.throws(
  () => normalizeTtsUsageLimitSettings({ maxCallDurationMinutes: 121 }),
  (error) => error.code === 'VOICE_TTS_USAGE_LIMIT_INVALID'
    && error.field === 'settings.maxCallDurationMinutes',
);
assert.throws(() => normalizeTtsUsageLimitSettings({ maxCallDurationMinutes: 1.5 }), /must be 0/);

console.log(JSON.stringify({ success: true, task: 'Per-agent TTS usage-limit settings' }));
