// Compatibility defaults for older agents with missing UI settings. Runtime
// consumers prefer explicitly saved values, including false and zero.
export const agentControlDefaults = Object.freeze({
  interruptionEnabled: true,
  interruptionSensitivity: 0.3,
  speechConfirmationDelayMs: 350,
  minimumMeaningfulWords: 2,
  maxInactivityPrompts: 1,
  inactivityTimeoutSeconds: 5,
  silenceTimeoutMs: 600,
});

export function resolveMaxInactivityPrompts(settings = {}) {
  const value = Number(settings.maxInactivityPrompts ?? agentControlDefaults.maxInactivityPrompts);
  return Number.isInteger(value) && value >= 1 && value <= 10
    ? value : agentControlDefaults.maxInactivityPrompts;
}
