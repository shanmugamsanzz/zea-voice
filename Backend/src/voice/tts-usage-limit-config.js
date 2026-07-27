export const ttsUsageLimitDefaults = Object.freeze({
  ttsMaxCharactersPerMinute: 0,
  maxCallDurationMinutes: 0,
});

function limit(value, field, label, minimum, maximum) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || (number !== 0 && (number < minimum || number > maximum))) {
    const error = new TypeError(`${label} must be 0 (unlimited) or an integer between ${minimum} and ${maximum}`);
    error.code = 'VOICE_TTS_USAGE_LIMIT_INVALID';
    error.field = `settings.${field}`;
    throw error;
  }
  return number;
}

export function normalizeTtsUsageLimitSettings(settings = {}) {
  return {
    ...settings,
    ttsMaxCharactersPerMinute: limit(
      settings.ttsMaxCharactersPerMinute ?? ttsUsageLimitDefaults.ttsMaxCharactersPerMinute,
      'ttsMaxCharactersPerMinute', 'Maximum characters per minute', 100, 10_000,
    ),
    maxCallDurationMinutes: limit(
      settings.maxCallDurationMinutes ?? ttsUsageLimitDefaults.maxCallDurationMinutes,
      'maxCallDurationMinutes', 'Maximum minutes per call', 1, 120,
    ),
  };
}
