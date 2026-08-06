const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'â€™_-]*/gu;
const incompleteEndings = new Set([
  'வந்து', 'எனக்கு', 'உங்களுக்கு', 'நீங்க', 'நான்', 'அது', 'இந்த', 'ஒரு',
  'and', 'or', 'to', 'for', 'with', 'about', 'the', 'a', 'an', 'i', 'you', 'my', 'your',
]);

function normalized(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function tokens(value) {
  return normalized(value).toLocaleLowerCase().match(wordPattern) ?? [];
}

function phraseMatches(source, phrase) {
  const phraseTokens = tokens(phrase);
  if (!phraseTokens.length || phraseTokens.length > source.length) return [];
  const matches = [];
  for (let index = 0; index <= source.length - phraseTokens.length; index += 1) {
    if (phraseTokens.every((word, offset) => source[index + offset] === word)) matches.push([index, phraseTokens.length]);
  }
  return matches;
}

export function acknowledgementOnly(text, phrases = []) {
  const source = tokens(text);
  if (!source.length) return false;
  const covered = new Array(source.length).fill(false);
  for (const phrase of phrases) {
    for (const [start, length] of phraseMatches(source, phrase)) {
      for (let offset = 0; offset < length; offset += 1) covered[start + offset] = true;
    }
  }
  return covered.every(Boolean);
}

function confidenceValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 1 ? numeric / 100 : numeric;
}

export function validateFinalCustomerTurn({
  text,
  confidence,
  minimumWords = 2,
  acknowledgementPhrases = [],
  rejectAcknowledgement = false,
  minimumConfidence = 0.55,
} = {}) {
  const finalText = normalized(text);
  const finalTokens = tokens(finalText);
  if (!finalText || !finalTokens.length) return { accepted: false, reason: 'empty', text: finalText };
  if (rejectAcknowledgement && acknowledgementOnly(finalText, acknowledgementPhrases)) {
    return { accepted: false, reason: 'acknowledgement_only', text: finalText };
  }
  const configuredMinimum = Math.min(3, Math.max(1, Number(minimumWords) || 2));
  if (finalTokens.length < configuredMinimum) return { accepted: false, reason: 'too_short', text: finalText };
  if (/[….]$/u.test(finalText) || incompleteEndings.has(finalTokens.at(-1))) {
    return { accepted: false, reason: 'incomplete', text: finalText };
  }
  const resolvedConfidence = confidenceValue(confidence);
  if (resolvedConfidence !== null && resolvedConfidence < minimumConfidence) {
    return { accepted: false, reason: 'low_confidence', text: finalText, confidence: resolvedConfidence };
  }
  return { accepted: true, text: finalText, confidence: resolvedConfidence, wordCount: finalTokens.length };
}
