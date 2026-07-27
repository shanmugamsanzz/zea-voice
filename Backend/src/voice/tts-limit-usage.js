const nonNegativeInteger = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};

export function normalizeTtsLimitUsage(value, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const throttleWaitMs = nonNegativeInteger(value.throttleWaitMs);
  return {
    maximumCharactersPerMinute: nonNegativeInteger(value.maximumCharactersPerMinute),
    maximumCallDurationMinutes: nonNegativeInteger(value.maximumCallDurationMinutes),
    charactersSynthesized: nonNegativeInteger(value.charactersSynthesized),
    currentWindowUsed: nonNegativeInteger(value.currentWindowUsed),
    throttleWaitMs,
    characterLimitApplied: throttleWaitMs > 0,
    durationLimitReached: value.durationLimitReached === true,
    callDurationSeconds: nonNegativeInteger(context.callDurationSeconds ?? value.callDurationSeconds),
  };
}
