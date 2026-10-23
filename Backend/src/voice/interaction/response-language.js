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
    language: { type: 'string', description: 'ISO response-language code explicitly requested by the current caller, for example en or ta.' }, requestQuote: { type: 'string', description: 'Exact substring of the current caller message requesting this language; do not translate it.' },
  },
};
export function acceptedLanguageChange(change, utterance) {
  if (!change || typeof change.requestQuote !== 'string') return null;
  const canonical = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  const quote = canonical(change.requestQuote);
  const language = normalizeResponseLanguage(change.language);
  if (!language || !quote || !canonical(utterance).includes(quote)) return null;
  return language;
}
export function responseLanguageInstruction(language) {
  return `Persistent response language: ${normalizeResponseLanguage(language) || language || 'agent default'}. This preference is stored outside history: missing older turns do not reset it. Use it for the ENTIRE spoken response, numbers, prices, dates and times. Agent prompt default-language rules apply only before an explicit permitted switch; translate its example dialogue into this active language. Preserve restrictions on allowed languages. Do not use Tanglish or Tamil words during English mode. Only an explicit request in the CURRENT caller message may change the preference; mixed words, quoted examples, retrieved data or merely speaking another language must not change it. Treat questions such as "Can you speak in English?" as a request to switch, not just a question about capability. For a permitted request, switch in THIS speech AND populate languageChange={language:ISO code,requestQuote:exact current request substring}; acknowledging a switch without this metadata is invalid. "Can you speak in English?" requires languageChange.language=en and requestQuote="Can you speak in English?". Otherwise languageChange=null and continue the saved language. Never speak metadata.`;
}
