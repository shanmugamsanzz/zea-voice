import assert from 'node:assert/strict';
import {
  normalizeTtsUsageLimitSettings,
  ttsUsageLimitDefaults,
} from '../src/voice/tts-usage-limit-config.js';

assert.deepEqual(normalizeTtsUsageLimitSettings({}), ttsUsageLimitDefaults);
assert.deepEqual(normalizeTtsUsageLimitSettings({
  ttsMaxCharactersPerMinute: 1000,
  maxCallDurationMinutes: 5,
  unrelatedSetting: true,
}), {
  ttsMaxCharactersPerMinute: 1000,
  maxCallDurationMinutes: 5,
  unrelatedSetting: true,
});
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
