const intentNames = Object.freeze([
  'overview', 'category_request', 'details', 'price', 'comparison', 'scenario',
  'booking_request', 'booking_field_answer', 'side_question', 'confirmation', 'unclear',
]);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim().replace(/\s+/gu, ' ');
}

function countWords(value) {
  return normalize(value).split(' ').filter(Boolean).length;
}

function matches(value, expressions) {
  return expressions.some((expression) => expression.test(value));
}

const expressions = Object.freeze({
  booking: [/\b(?:book|booking|reserve|reservation|appointment|schedule)\b/iu, /(?:புக்|booking|appointment|அப்பாயின்மென்ட்|நேரம் பதிவு|ரிசர்வ்|முன்பதிவு)/u],
  price: [/\b(?:price|cost|rate|amount|how much|fee|charge)\b/iu, /(?:விலை|எவ்வளவு|amount|rate|கட்டணம்|செலவு)/u],
  comparison: [/\b(?:compare|comparison|difference|versus|vs|better)\b/iu, /(?:வித்தியாசம்|ஒப்பிடு|எது நல்லது|வேறுபாடு)/u],
  details: [/\b(?:detail|details|explain|include|included|about|tell me)\b/iu, /(?:விவரம்|detail|explain|சொல்லுங்க|என்னென்ன|இதுல என்ன|பத்தி)/u],
  overview: [/\b(?:all|available|list|options|what .*?(?:have|offer|available)|which .*?(?:services|products|packages|plans))\b/iu, /(?:என்னென்ன|எல்லா|வேற என்ன|available|list|options|பேக்கேஜ்.*இருக்கு|package.*இருக்கு)/u],
  scenario: [/\b(?:pain|problem|symptom|suffering|hurt|issue|need|recommend|choose|suitable|for me)\b/iu, /(?:வலி|பிரச்சனை|problem|symptom|எந்த.*(?:choose|பண்ண)|எனக்கு.*இருக்கு|சரியில்லை)/u],
  confirmation: [/^(?:(?:yes|yeah|yep|ok|okay|sure|correct|confirm|no|nope)\s*)+$/iu, /^(?:(?:ஆமா|ஆம்|சரி|ம்|ஹம்|வேணாம்|இல்லை|இல்லங்க|பண்ணலாம்)\s*)+$/u],
  sideQuestion: [/\b(?:where|location|address|direction|why|who|when|how|phone|number|timing|open)\b/iu, /(?:எங்கே|எங்க|location|address|எதுக்கு|எப்படி|யாரு|எப்ப|number|டைமிங்)/u],
});

function result(intent, confidence, signals = []) {
  return Object.freeze({
    intent,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 10_000) / 10_000,
    signals: Object.freeze([...new Set(signals)]),
  });
}

// Fast industry-neutral classification. It identifies conversational meaning only;
// Catalog entities and tenant facts remain in published tenant Knowledge.
export function detectConversationIntent(text, { pendingQuestion, pendingQuestionKind } = {}) {
  const value = normalize(text);
  if (!value || countWords(value) === 0) return result('unclear', 0, ['empty']);
  if (countWords(value) === 1 && !matches(value, expressions.confirmation)) return result('unclear', 0.25, ['single_token']);
  if (matches(value, expressions.confirmation)) return result('confirmation', 0.95, ['confirmation']);
  if (matches(value, expressions.booking)) return result('booking_request', 0.96, ['booking']);
  if (pendingQuestion && pendingQuestionKind === 'field' && !matches(value, expressions.sideQuestion)) {
    return result('booking_field_answer', 0.78, ['pending_field']);
  }
  if (matches(value, expressions.comparison)) return result('comparison', 0.93, ['comparison']);
  if (matches(value, expressions.price)) return result('price', 0.93, ['price']);
  if (matches(value, expressions.scenario)) return result('scenario', 0.86, ['scenario']);
  if (matches(value, expressions.overview)) return result('overview', 0.9, ['overview']);
  if (matches(value, expressions.sideQuestion)) return result('side_question', 0.82, ['side_question']);
  if (/\bpackages\b|(?:பேக்கேஜஸ்|பக்கேஜஸ்|பேக்கஜஸ்)/iu.test(value)) {
    return result('category_request', 0.78, ['catalog_plural']);
  }
  if (matches(value, expressions.details)) return result('details', 0.72, ['details']);
  if (/\b(?:package|packages|plan|plans|service|services|product|products|checkup|check up)\b|(?:பேக்கேஜ்|பக்கேஜ்|பேக்கஜ்|சேவை|செக்கப்)/iu.test(value)) {
    return result('category_request', 0.62, ['catalog_term']);
  }
  return result('unclear', 0.35, ['no_generic_signal']);
}

export { intentNames };
