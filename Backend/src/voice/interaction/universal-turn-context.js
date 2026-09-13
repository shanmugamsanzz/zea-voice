function text(value, limit = 2000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, limit);
}

// Preserve chronological fragments and delivered openings, including messages
// that have no matching reply. Never infer semantic completion from keywords.
export function buildUniversalTurnContext({ currentQuestion, conversationHistory = [],
  pendingQuestion = null, speechStatus = {} } = {}) {
  const question = text(currentQuestion);
  const history = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter((entry) => ['user', 'assistant'].includes(entry?.role)
      && entry.isFinal !== false && entry.audible !== false)
    .map((entry) => ({ role: entry.role, content: text(entry.content),
      completion: entry.interrupted === true ? 'interrupted'
        : entry.complete === false ? 'incomplete' : 'complete' }))
    .filter((entry) => entry.content);
  // The controller appends this finalized question before invoking the engine.
  // Remove only that trailing occurrence; earlier repetitions remain context.
  if (history.at(-1)?.role === 'user' && history.at(-1).content === question) history.pop();
  const recent = [];
  let remaining = 6000;
  for (const entry of history.slice(-12).reverse()) {
    if (entry.content.length > remaining) break;
    recent.push(Object.freeze(entry));
    remaining -= entry.content.length;
  }
  recent.reverse();
  const lastAssistant = [...recent].reverse().find((entry) => entry.role === 'assistant');
  const pending = typeof pendingQuestion === 'string' ? text(pendingQuestion)
    : pendingQuestion && typeof pendingQuestion === 'object'
      ? Object.fromEntries(Object.entries(pendingQuestion).slice(0, 12)
        .filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value))
        .map(([key, value]) => [key, typeof value === 'string' ? text(value) : value])) : null;
  return Object.freeze({
    currentQuestion: question,
    recentConversation: Object.freeze(recent),
    lastAssistantResponse: lastAssistant ?? null,
    // A question cut off during playback must not authorize confirmation.
    pendingQuestion: ['interrupted', 'incomplete'].includes(lastAssistant?.completion) ? null : pending,
    currentSpeech: Object.freeze({
      transcriptFinal: speechStatus.transcriptFinal === true,
      semanticCompletion: speechStatus.semanticCompletion === 'incomplete' ? 'incomplete' : 'unknown',
      speechEnded: speechStatus.speechEnded === true,
    }),
  });
}
