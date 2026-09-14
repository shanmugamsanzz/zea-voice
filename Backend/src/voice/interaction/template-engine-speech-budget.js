export function normalizedSpeechBudget(value) {
  const maximum = Number(value);
  return Number.isFinite(maximum) && maximum > 0 ? Math.floor(maximum) : null;
}

export function speechBudgetInstruction(value) {
  const maximum = normalizedSpeechBudget(value);
  return maximum
    ? `Keep the spoken answer within ${maximum} characters, including spaces and punctuation.`
    : '';
}

export function llmTokenBudgetForSpeech(value) {
  const maximum = normalizedSpeechBudget(value);
  // Structured workflow fields need a small protocol allowance. The spoken
  // portion remains governed exclusively by the agent's UI character limit.
  return maximum ? Math.min(4_096, Math.max(256, Math.ceil(maximum * 2) + 192)) : 4_096;
}
