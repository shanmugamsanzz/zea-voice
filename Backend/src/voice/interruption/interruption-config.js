const thresholdBySensitivity = { low: 700, medium: 350, high: 150 };

export const defaultAcknowledgementPhrases = Object.freeze([
  'ம்', 'ஹம்', 'ஆமா', 'சரி', 'ok', 'okay', 'sure', 'சொல்லுங்க',
]);

export const defaultExplicitStopPhrases = Object.freeze([
  'நிறுத்துங்க', 'ஒரு நிமிஷம்', 'கொஞ்சம் இருங்க', 'wait', 'stop', 'வேண்டாம்',
]);

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function sensitivity(value, numericFallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.startsWith('low')) return 'low';
  if (normalized.startsWith('high')) return 'high';
  if (normalized.startsWith('medium')) return 'medium';
  const numeric = Number(numericFallback);
  if (Number.isFinite(numeric) && numeric <= 0.2) return 'high';
  if (Number.isFinite(numeric) && numeric > 0.5) return 'low';
  return 'medium';
}

function triggerWords(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((entry) => entry.slice(0, 50)))];
}

function configuredPhrases(value, fallback) {
  const normalized = triggerWords(value);
  return normalized.length ? normalized : [...fallback];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function legacyDelay(settings, numericSensitivity) {
  const explicit = Number(settings.speechConfirmationDelayMs);
  if (Number.isFinite(explicit)) return boundedInteger(explicit, 350, 150, 1500);
  return thresholdBySensitivity[sensitivity(settings.interruptionSensitivityLabel, numericSensitivity)];
}

export function resolveInterruptionConfiguration(settings = {}, numericSensitivity = 0.3) {
  const confirmationDelayMs = legacyDelay(settings, numericSensitivity);
  const configuredMinimum = settings.minimumMeaningfulWords
    ?? settings.wordInterruptionMinWords
    ?? settings.minimumInterruptionWords
    ?? 2;
  // `wordInterruptionTriggerWords` is retained only as a legacy alias. New
  // agents use explicitStopPhrases, while acknowledgement phrases are stored
  // separately for the transcript classifier added in the next task.
  const explicitStopPhrases = configuredPhrases(settings.explicitStopPhrases
    ?? settings.wordInterruptionTriggerWords
    ?? settings.interruptionTriggerWords
    ?? defaultExplicitStopPhrases, defaultExplicitStopPhrases);
  return Object.freeze({
    timeBased: Object.freeze({
      enabled: boolean(settings.timeBasedInterruptionEnabled, true),
      thresholdMs: confirmationDelayMs,
    }),
    wordBased: Object.freeze({
      // The old independent Word Based toggle is deprecated. The main
      // interruption toggle now controls the whole transcript-confirmed flow.
      enabled: boolean(settings.timeBasedInterruptionEnabled, true),
      minimumWords: boundedInteger(configuredMinimum, 2, 1, 3),
      triggerWords: Object.freeze(explicitStopPhrases),
    }),
    acknowledgementPhrases: Object.freeze(configuredPhrases(
      settings.acknowledgementPhrases ?? defaultAcknowledgementPhrases,
      defaultAcknowledgementPhrases,
    )),
    explicitStopPhrases: Object.freeze(explicitStopPhrases),
  });
}

export function normalizeInterruptionSettings(settings = {}, numericSensitivity = 0.3) {
  const config = resolveInterruptionConfiguration(settings, numericSensitivity);
  return {
    ...settings,
    timeBasedInterruptionEnabled: config.timeBased.enabled,
    speechConfirmationDelayMs: config.timeBased.thresholdMs,
    minimumMeaningfulWords: config.wordBased.minimumWords,
    acknowledgementPhrases: [...config.acknowledgementPhrases],
    explicitStopPhrases: [...config.explicitStopPhrases],
    // Preserve these fields for existing API consumers. Runtime logic no
    // longer uses sensitivity or policy to allow sound-only interruption.
    wordBasedInterruptionEnabled: config.wordBased.enabled,
    wordInterruptionMinWords: config.wordBased.minimumWords,
    wordInterruptionTriggerWords: [...config.explicitStopPhrases],
  };
}

