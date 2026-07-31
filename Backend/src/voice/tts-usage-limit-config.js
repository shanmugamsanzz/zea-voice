export const ttsUsageLimitDefaults = Object.freeze({
  ttsMaxCharactersPerResponse: 0,
  ttsMaxCharactersPerMinute: 0,
  maxCallDurationMinutes: 0,
  ttsLimitFallbackMessage: '',
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
  const fallbackMessage = String(settings.ttsLimitFallbackMessage ?? '').trim();
  const responseLimit = limit(
    settings.ttsMaxCharactersPerResponse ?? ttsUsageLimitDefaults.ttsMaxCharactersPerResponse,
    'ttsMaxCharactersPerResponse', 'Maximum characters per response', 50, 5_000,
  );
  const minuteLimit = limit(
    settings.ttsMaxCharactersPerMinute ?? ttsUsageLimitDefaults.ttsMaxCharactersPerMinute,
    'ttsMaxCharactersPerMinute', 'Maximum characters per minute', 100, 10_000,
  );
  const activeCharacterLimits = [responseLimit, minuteLimit].filter((value) => value > 0);
  const effectiveCharacterLimit = activeCharacterLimits.length ? Math.min(...activeCharacterLimits) : 0;
  if (fallbackMessage.length > 500) {
    const error = new TypeError('Complete fallback message cannot exceed 500 characters');
    error.code = 'VOICE_TTS_USAGE_LIMIT_INVALID';
    error.field = 'settings.ttsLimitFallbackMessage';
    throw error;
  }
  if (responseLimit > 0 && !fallbackMessage) {
    const error = new TypeError('Complete fallback message is required when maximum characters per response is enabled');
    error.code = 'VOICE_TTS_USAGE_LIMIT_INVALID';
    error.field = 'settings.ttsLimitFallbackMessage';
    throw error;
  }
  if (responseLimit > 0 && Array.from(fallbackMessage).length > effectiveCharacterLimit) {
    const error = new TypeError('Complete fallback message must fit within the effective response character limit');
    error.code = 'VOICE_TTS_USAGE_LIMIT_INVALID';
    error.field = 'settings.ttsLimitFallbackMessage';
    throw error;
  }
  if (responseLimit > 0 && !/[.!?\u2026\u0964\u3002\uff01\uff1f]["'\u201d\u2019)\]]*$/u.test(fallbackMessage)) {
    const error = new TypeError('Complete fallback message must end with sentence punctuation');
    error.code = 'VOICE_TTS_USAGE_LIMIT_INVALID';
    error.field = 'settings.ttsLimitFallbackMessage';
    throw error;
  }
  return {
    ...settings,
    ttsMaxCharactersPerResponse: responseLimit,
    ttsMaxCharactersPerMinute: minuteLimit,
    maxCallDurationMinutes: limit(
      settings.maxCallDurationMinutes ?? ttsUsageLimitDefaults.maxCallDurationMinutes,
      'maxCallDurationMinutes', 'Maximum minutes per call', 1, 120,
    ),
    ttsLimitFallbackMessage: fallbackMessage,
  };
}
