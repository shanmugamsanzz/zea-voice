export function normalizedSpeechBudget(value) {
  const maximum = Number(value);
  return Number.isFinite(maximum) && maximum > 0 ? Math.floor(maximum) : null;
}

export function speechBudgetInstruction(value) {
  const maximum = normalizedSpeechBudget(value);
  return maximum ? [
    `The configured caller-facing speech budget is ${maximum} characters, including spaces, punctuation and any follow-up question.`,
    'Write a complete, concise answer that fits this budget before delivery. Prioritize the requested facts over introductions, repetition and optional follow-ups.',
    'For comparisons, cover every requested operand and the essential requested differences concisely. If extensive detail remains, briefly offer further detail within the response and budget; never replace the requested answer with that offer.',
    'Do not remove a requested operand, alter facts or citations, invent a summary, or claim missing information merely to fit. Keep optional nextQuestion null when there is no room.',
  ].join(' ') : '';
}
