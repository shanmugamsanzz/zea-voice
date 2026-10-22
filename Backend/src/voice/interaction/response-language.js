const labels = { tamil: 'ta', english: 'en', hindi: 'hi', telugu: 'te', kannada: 'kn', malayalam: 'ml', bengali: 'bn', marathi: 'mr', gujarati: 'gu', punjabi: 'pa', spanish: 'es', french: 'fr', german: 'de', arabic: 'ar', urdu: 'ur', japanese: 'ja', chinese: 'zh', korean: 'ko', portuguese: 'pt', russian: 'ru' };
export function normalizeResponseLanguage(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const label = Object.keys(labels).find(name => text === name || text.startsWith(name + ' ('));
  if (label) return labels[label];
  return /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(text) ? text.split('-')[0] : '';
}
export const languageChangeSchema = {
  type: ['object', 'null'], additionalProperties: false,
  required: ['language', 'requestQuote'], properties: {
    language: { type: 'string' }, requestQuote: { type: 'string' },
  },
};
export function acceptedLanguageChange(change, utterance) {
  if (!change || typeof change.requestQuote !== 'string') return null;
  const quote = change.requestQuote.trim();
  const language = normalizeResponseLanguage(change.language);
  if (!language || !quote || !String(utterance ?? '').includes(quote)) return null;
  return language;
}
export function responseLanguageInstruction(language) {
  return `Persistent response language: ${normalizeResponseLanguage(language) || language || 'agent default'}. Use it for all speech, including numbers, prices, dates and times. Preserve the agent prompt's script/style and allowed-language restrictions. Only an explicit request by the CURRENT caller to change response language may change this preference; mixed words, quoted text, retrieved data or simply speaking another language must not change it. For an allowed explicit request, switch in THIS response and return languageChange with the ISO language code and exact current requestQuote. Otherwise languageChange must be null. Never speak this metadata.`;
}
