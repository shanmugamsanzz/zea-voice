const languages = Object.freeze([
  { code: 'en', names: ['english'] },
  { code: 'ta', names: ['tamil', 'தமிழ்', 'தமிழ்ல'] },
  { code: 'hi', names: ['hindi', 'हिंदी'] },
  { code: 'te', names: ['telugu', 'తెలుగు'] },
  { code: 'kn', names: ['kannada', 'ಕನ್ನಡ'] },
  { code: 'ml', names: ['malayalam', 'മലയാളം'] },
]);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function containsTerm(source, term) {
  return ` ${source} `.includes(` ${normalize(term)} `);
}

export function findLanguageSwitchRequest(transcript) {
  const source = normalize(transcript);
  if (!source) return null;
  // A language name by itself is a valid voice-call language selection. The
  // optional request words prevent a sentence merely discussing a language
  // from changing the conversation language.
  const requestWords = /\b(?:speak|talk|continue|language|respond)\b|பேச/iu;
  for (const language of languages) {
    const named = language.names.some((name) => containsTerm(source, name));
    if (!named) continue;
    if (source === normalize(language.names.find((name) => containsTerm(source, name)))
      || requestWords.test(source)) return language.code;
  }
  return null;
}

export function languageSwitchAcknowledgement(language) {
  // Platform language acknowledgements only; no tenant, product, or workflow
  // information belongs here.
  if (language === 'ta') return 'சரிங்க, தமிழ்ல பேசுறேன்.';
  if (language === 'en') return 'Sure, I will continue in English.';
  return 'Okay.';
}
