const maximumText = 8_000;

function text(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximumText);
}

function identity(value) {
  return text(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function tokens(value) {
  return identity(value).split(' ').filter((token) => token.length >= 3 || /\d/u.test(token));
}

function numbers(value) {
  return new Set((text(value).match(/\p{Sc}?\s*\d[\d,.:%/-]*/gu) ?? [])
    .map((entry) => entry.replace(/[^\d]/gu, '')).filter(Boolean));
}

function sentences(value) {
  const normalized = text(value);
  if (!normalized) return [];
  if (globalThis.Intl?.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(normalized)]
      .map((entry) => entry.segment.trim()).filter(Boolean);
  }
  return normalized.split(/(?<=[.!?ï¼Ÿ])\s+/u).map((entry) => entry.trim()).filter(Boolean);
}

function overlap(left, right) {
  const leftTokens = tokens(left);
  if (!leftTokens.length) return 0;
  const rightTokens = new Set(tokens(right));
  return leftTokens.filter((token) => rightTokens.has(token)).length / leftTokens.length;
}

const negationPattern = /(?:\b(?:no|not|never|none|without|unavailable|cannot|can't|won't|doesn't|isn't|aren't|didn't)\b|\u0B87\u0BB2\u0BCD\u0BB2\u0BC8|\u0B95\u0BBF\u0B9F\u0BC8\u0BAF\u0BBE\u0BA4\u0BC1|\u0B85\u0BB2\u0BCD\u0BB2|\u0BAE\u0BC1\u0B9F\u0BBF\u0BAF\u0BBE\u0BA4\u0BC1|\u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BBE\u0BAE\u0BCD|\b(?:illa|illai|kidaiyathu|mudiyathu|vendam)\b)/iu;
const actionSuccessPattern = /(?:\b(?:confirmed|completed|successful|successfully|booked|scheduled|sent|transferred|created|updated|cancelled|refunded|reserved)\b|\u0B86\u0B95\u0BBF\u0BB5\u0BBF\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1|\u0BAE\u0BC1\u0B9F\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0BB5\u0BBF\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1|\b(?:confirm|book|schedule|send|transfer|complete)\s+(?:aagiduchu|ayiduchu|panniyachu|panniten)\b)/iu;
const actionObjectPattern = /\b(?:action|appointment|booking|callback|case|message|order|payment|refund|request|reservation|ticket|transfer|tool)\b/iu;
const internalGuidancePattern = /(?:grounded[_ ]response|evidenceids|stateupdate|toolrequest|runtime context|system prompt|response[_ ]mode|action[_ ]config|\bcaller\s+(?:asked|requested|said|\u0B95\u0BC7\u0B9F\u0BCD\u0B9F)|\b(?:retrieve|rank|hydrate|validate)\s+(?:the\s+)?(?:approved|evidence|record)|\b(?:must|should)\s+(?:ask|answer|retrieve|use|resume|execute|transfer))/iu;

function hasNegation(value) {
  return !/\bnot\s+only\b/iu.test(value) && negationPattern.test(value);
}

function claimsActionSuccess(value) {
  return actionSuccessPattern.test(value) && actionObjectPattern.test(value);
}

function verifiedActionSource(source) {
  const type = String(source?.recordType ?? '').toLocaleUpperCase();
  const data = source?.authoritativeData ?? {};
  return type.includes('TOOL') && data.verified === true && typeof data.success === 'boolean';
}

export function containsInternalGuidance(value) {
  return internalGuidancePattern.test(text(value))
    || /^\s*(?:instruction|workflow|debug|json|response|action)\s*:/iu.test(text(value));
}

export function validateGroundedClaim(sentence, sources = [], options = {}) {
  const claim = text(sentence);
  if (!claim) return Object.freeze({ valid: false, reason: 'empty_claim' });
  if (containsInternalGuidance(claim)) {
    return Object.freeze({ valid: false, reason: 'internal_guidance' });
  }
  const evidenceText = sources.map((source) => text(source?.content)).join(' ');
  const evidenceNumbers = numbers(evidenceText);
  if ([...numbers(claim)].some((number) => !evidenceNumbers.has(number))) {
    return Object.freeze({ valid: false, reason: 'unsupported_numeric_fact' });
  }
  const evidenceSentences = sources.flatMap((source) => sentences(source?.content));
  const ranked = evidenceSentences.map((candidate) => ({ candidate, score: overlap(claim, candidate) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0] ?? { candidate: '', score: 0 };
  const claimNegated = hasNegation(claim);
  const evidenceNegated = hasNegation(best.candidate);
  if (claimNegated && best.score >= 0.2 && !evidenceNegated) {
    return Object.freeze({ valid: false, reason: 'unsupported_negation' });
  }
  if (!claimNegated && best.score >= 0.45 && evidenceNegated) {
    return Object.freeze({ valid: false, reason: 'contradictory_claim' });
  }
  if (claimsActionSuccess(claim)
    && !sources.some(verifiedActionSource)
    && options.allowVerifiedActionClaim !== true) {
    return Object.freeze({ valid: false, reason: 'unauthorized_action_claim' });
  }
  return Object.freeze({ valid: true, bestEvidence: best.candidate, overlap: best.score });
}

export function validateGroundedClaims(value, sources = [], options = {}) {
  for (const sentence of sentences(value)) {
    const result = validateGroundedClaim(sentence, sources, options);
    if (!result.valid) return Object.freeze({ ...result, sentence });
  }
  return Object.freeze({ valid: true });
}
