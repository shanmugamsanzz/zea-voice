// Deprecated compatibility surface. Ordinary caller understanding belongs to
// the single grounded LLM turn; application code contains no caller-word or
// business-intent dictionary.
const intentNames = Object.freeze(['unclear']);

export function detectConversationIntent() {
  return Object.freeze({ intent: 'unclear', confidence: 0, signals: Object.freeze([]) });
}

export { intentNames };
