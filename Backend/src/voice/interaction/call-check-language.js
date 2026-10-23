import { normalizeResponseLanguage } from './response-language.js';
export function resolveCallCheckResponse(settings = {}, activeLanguage, defaultLanguage) {
  const active = normalizeResponseLanguage(activeLanguage || defaultLanguage);
  const fallback = normalizeResponseLanguage(defaultLanguage);
  const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0,500) : '';
  const localized = clean(settings.callCheckResponses?.[active]);
  if (localized) return localized;
  // Legacy text is approved only for the agent's default language. If no
  // translation exists after a switch, route normally to the language-locked LLM.
  return active === fallback ? clean(settings.callCheckResponse) : '';
}
export function validateCallCheckResponses(settings = {}) {
  const responses = settings.callCheckResponses;
  if (responses === undefined) return;
  if (!responses || typeof responses !== 'object' || Array.isArray(responses) || Object.keys(responses).length > 20) throw new Error('Call Check Responses must contain at most 20 language entries');
  for (const [language,text] of Object.entries(responses)) {
    if (normalizeResponseLanguage(language) !== language || typeof text !== 'string' || text.length > 500) throw new Error('Use language codes and Call Check Responses of at most 500 characters');
  }
}
export function ongoingCallInstruction({openingStarted=false,openingDelivered=false,conversationStarted=false}={}) {
  if (!openingStarted && !openingDelivered && !conversationStarted) return '';
  return `Ongoing call state (independent of history): openingStarted=${openingStarted}, openingDelivered=${openingDelivered}, conversationStarted=${conversationStarted}. Do not restart your introduction, replay the welcome, or ask initial permission to talk again. Hello/are-you-there is a presence check: acknowledge briefly in the active response language and answer the current need or resume the pending step. Even if the opening was interrupted, do not replay it. This does not prohibit asking consent for a new action or asking whether to continue a pending task.`;
}
