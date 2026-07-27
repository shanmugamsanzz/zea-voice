const sensitivityLabels = {
  low: 'Low (agent rarely gets interrupted by background noise)',
  medium: 'Medium (ideal for regular conversations)',
  high: 'High (agent stops speaking instantly at any user sound)',
};

const thresholdBySensitivity = { low: 700, medium: 350, high: 150 };

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

export function resolveInterruptionConfiguration(settings = {}, numericSensitivity = 0.3) {
  const level = sensitivity(settings.interruptionSensitivityLabel, numericSensitivity);
  const configuredMinimum = Number(settings.wordInterruptionMinWords ?? settings.minimumInterruptionWords ?? 2);
  return Object.freeze({
    timeBased: Object.freeze({
      enabled: boolean(settings.timeBasedInterruptionEnabled, true),
      sensitivity: level,
      thresholdMs: thresholdBySensitivity[level],
    }),
    wordBased: Object.freeze({
      enabled: boolean(settings.wordBasedInterruptionEnabled, false),
      minimumWords: Number.isInteger(configuredMinimum) ? Math.min(5, Math.max(1, configuredMinimum)) : 2,
      triggerWords: Object.freeze(triggerWords(
        settings.wordInterruptionTriggerWords ?? settings.interruptionTriggerWords ?? [],
      )),
    }),
    policy: String(settings.interruptionPolicy ?? 'any').toLowerCase() === 'all' ? 'all' : 'any',
  });
}

export function normalizeInterruptionSettings(settings = {}, numericSensitivity = 0.3) {
  const config = resolveInterruptionConfiguration(settings, numericSensitivity);
  return {
    ...settings,
    timeBasedInterruptionEnabled: config.timeBased.enabled,
    interruptionSensitivityLabel: sensitivityLabels[config.timeBased.sensitivity],
    wordBasedInterruptionEnabled: config.wordBased.enabled,
    wordInterruptionMinWords: config.wordBased.minimumWords,
    wordInterruptionTriggerWords: [...config.wordBased.triggerWords],
    interruptionPolicy: config.policy,
  };
}

