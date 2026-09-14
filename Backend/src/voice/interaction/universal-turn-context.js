function text(value, limit = 2000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function configuredConversation(entries, mode, recentTurns) {
  if (mode === 'full_current_call') return entries;
  const requestedTurns = Number(recentTurns);
  const turnLimit = Number.isInteger(requestedTurns) && requestedTurns > 0
    ? requestedTurns : 5;
  let callerTurns = 0;
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].role !== 'user') continue;
    callerTurns += 1;
    if (callerTurns === turnLimit) {
      start = index;
      break;
    }
  }
  return entries.slice(start);
}

// Preserve chronological fragments and delivered openings, including messages
// that have no matching reply. Never infer semantic completion from keywords.
export function buildUniversalTurnContext({ currentQuestion, conversationHistory = [],
  pendingQuestion = null, speechStatus = {}, conversationContextMode = 'last_n_turns',
  conversationContextTurns = 5 } = {}) {
  const question = text(currentQuestion);
  const audibleHistory = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter((entry) => ['user', 'assistant'].includes(entry?.role)
      && entry.isFinal !== false && entry.audible !== false)
    .map((entry) => ({ role: entry.role, content: text(entry.content),
      completion: entry.interrupted === true ? 'interrupted'
        : entry.complete === false ? 'incomplete' : 'complete' }))
    .filter((entry) => entry.content);
  // The controller appends this finalized question before invoking the engine.
  // Remove only that trailing occurrence; earlier repetitions remain context.
  if (audibleHistory.at(-1)?.role === 'user'
    && audibleHistory.at(-1).content === question) audibleHistory.pop();
  const lastAssistant = [...audibleHistory].reverse()
    .find((entry) => entry.role === 'assistant');
  const history = audibleHistory.filter((entry) => entry.completion === 'complete');
  const recent = configuredConversation(
    history, conversationContextMode, conversationContextTurns,
  ).map((entry) => Object.freeze(entry));
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
