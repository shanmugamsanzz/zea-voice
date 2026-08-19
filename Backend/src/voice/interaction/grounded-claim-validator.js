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

function sourceContent(source) {
  let structured = '';
  try {
    structured = source?.authoritativeData && typeof source.authoritativeData === 'object'
      ? JSON.stringify(source.authoritativeData)
      : '';
  } catch {
    structured = '';
  }
  return `${text(source?.content)} ${text(structured)}`.trim();
}

function sameValue(left, right) {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  return identity(left) === identity(right);
}

function callerSupportsValue(value, utterance) {
  const normalizedValue = identity(value);
  const normalizedUtterance = identity(utterance);
  if (!normalizedValue || !normalizedUtterance) return false;
  if (normalizedUtterance.includes(normalizedValue)) return true;
  const valueNumbers = normalizedValue.match(/\d+/gu) ?? [];
  const utteranceNumbers = new Set(normalizedUtterance.match(/\d+/gu) ?? []);
  if (valueNumbers.length && valueNumbers.every((number) => (
    utteranceNumbers.has(number) || (number === '00' && utteranceNumbers.size > 0)
  ))) return true;
  const valueTokens = tokens(normalizedValue);
  const utteranceTokens = new Set(tokens(normalizedUtterance));
  return valueTokens.length > 0 && valueTokens.every((token) => utteranceTokens.has(token));
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
const medicalClaimPattern = /(?:\b(?:diagnos(?:e|ed|is)|cure[sd]?|treat(?:s|ed|ment)?|prescrib(?:e|ed)|detect(?:s|ed|ion)?|prevent(?:s|ed|ion)?|rule[sd]?\s+out|medically\s+suitable|guarantee[sd]?)\b|\b(?:noi|disease|cancer|symptom|medicine|tablet)\b[^.!?]{0,80}\b(?:confirm|detect|cure|treat|prevent|suitable)\b|\b(?:diagnose|cure|treat|detect|prevent|suitable)\s+(?:pann|aag|irukk)|\u0B95\u0BC1\u0BA3\u0BAE\u0BBE\u0B95\u0BCD\u0B95|\u0B95\u0BA3\u0BCD\u0B9F\u0BC1\u0BAA\u0BBF\u0B9F\u0BBF\u0B95\u0BCD\u0B95|\u0BA8\u0BCB\u0BAF\u0BC8\s*\u0B89\u0BB1\u0BC1\u0BA4\u0BBF)/iu;
const medicalAssertionPattern = /(?:\b(?:diagnos(?:e|ed|es|is)|cure[sd]?|treat(?:s|ed|ment)?|prescrib(?:e|ed|es)|detect(?:s|ed|ion)?|prevent(?:s|ed|ion)?|rule[sd]?\s+out|medically\s+suitable|guarantee[sd]?)\b|\b(?:diagnose|cure|treat|detect|prevent|suitable)\s+(?:pann|aag|irukk)|\u0B95\u0BC1\u0BA3\u0BAE\u0BBE\u0B95\u0BCD\u0B95|\u0B95\u0BA3\u0BCD\u0B9F\u0BC1\u0BAA\u0BBF\u0B9F\u0BBF\u0B95\u0BCD\u0B95|\u0BA8\u0BCB\u0BAF\u0BC8\s*\u0B89\u0BB1\u0BC1\u0BA4\u0BBF)/iu;
const unsupportedMedicalAdvicePattern = /\b(?:start|stop|change|take|avoid|increase|decrease|recommend|prescribe)\b[^.!?]{0,80}\b(?:medicine|medication|tablet|dose|dosage|drug|treatment)\b/iu;

function unsupportedStructuredIdentifiers(claim, evidenceText) {
  const evidence = new Set((String(evidenceText).match(/\b[A-Z][A-Z0-9-]{1,}\b/gu) ?? [])
    .map((entry) => entry.toLocaleUpperCase()));
  return [...new Set((String(claim).match(/\b[A-Z][A-Z0-9-]{1,}\b/gu) ?? [])
    .map((entry) => entry.toLocaleUpperCase()))].filter((entry) => !evidence.has(entry));
}

function hasNegation(value) {
  return !/\bnot\s+only\b/iu.test(value) && negationPattern.test(value);
}

function claimsActionSuccess(value) {
  return actionSuccessPattern.test(value) && actionObjectPattern.test(value);
}

function verifiedActionSource(source) {
  const type = String(source?.recordType ?? '').toLocaleUpperCase();
  const data = source?.authoritativeData ?? {};
  return type.includes('TOOL') && data.verified === true && data.success === true;
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
  if (!sources.length && options.configuredSpeech !== true) {
    return Object.freeze({ valid: false, reason: 'selected_evidence_missing' });
  }
  const evidenceText = sources.map(sourceContent).join(' ');
  const normalizedEvidence = identity(evidenceText);
  const evidenceNumbers = numbers(evidenceText);
  if ([...numbers(claim)].some((number) => !evidenceNumbers.has(number))) {
    return Object.freeze({ valid: false, reason: 'unsupported_numeric_fact' });
  }
  const unsupportedIdentifiers = unsupportedStructuredIdentifiers(claim, evidenceText);
  if (unsupportedIdentifiers.length) {
    return Object.freeze({
      valid: false, reason: 'unsupported_structured_fact', identifiers: unsupportedIdentifiers,
    });
  }
  const evidenceSentences = sources.flatMap((source) => sentences(source?.content));
  const ranked = evidenceSentences.map((candidate) => ({ candidate, score: overlap(claim, candidate) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0] ?? { candidate: '', score: 0 };
  const unsupportedEntity = (options.knownEntities ?? []).find((entity) => {
    const name = identity(entity?.name);
    return name.length >= 3 && identity(claim).includes(name) && !normalizedEvidence.includes(name);
  });
  if (unsupportedEntity) {
    return Object.freeze({ valid: false, reason: 'unsupported_entity', entity: unsupportedEntity.key ?? unsupportedEntity.name });
  }
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
  if ((medicalAssertionPattern.test(claim) && !medicalAssertionPattern.test(evidenceText))
    || (medicalClaimPattern.test(claim) && best.score < 0.45)) {
    return Object.freeze({ valid: false, reason: 'unsupported_medical_claim' });
  }
  if (unsupportedMedicalAdvicePattern.test(claim)
    && !unsupportedMedicalAdvicePattern.test(evidenceText)) {
    return Object.freeze({ valid: false, reason: 'unsupported_medical_advice' });
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

export function hydrateSelectedEvidence(decision, envelope, authoritativeSources = []) {
  const selected = new Set([
    ...(decision?.evidenceIds ?? []),
    ...(decision?.evidenceSourceIds ?? []),
  ]);
  return (envelope?.sources ?? []).filter((source) => selected.has(source.id)).map((source) => (
    authoritativeSources.find((candidate) => (
      candidate.id === source.id
      || (source.recordId && candidate.recordId === source.recordId)
    )) ?? null
  )).filter(Boolean);
}

export function hydrateGroundingEnvelope(envelope, authoritativeSources = []) {
  const sources = (envelope?.sources ?? []).map((source) => {
    const authoritative = authoritativeSources.find((candidate) => (
      candidate.id === source.id
      || (source.recordId && candidate.recordId === source.recordId)
    ));
    return authoritative ? Object.freeze({
      ...source, ...authoritative,
      // The envelope may explicitly mark the retrieval-selected guidance
      // RESPONSE as caller-facing; authoritative metadata still controls all
      // tenant/revision identity and factual fields.
      callerFacing: source.callerFacing === true ? true : authoritative.callerFacing,
      id: source.id,
      recordId: source.recordId ?? authoritative.recordId,
    }) : null;
  }).filter(Boolean);
  return Object.freeze({
    ...envelope,
    found: envelope?.found === true && sources.length > 0,
    sources: Object.freeze(sources),
  });
}

export function validateCallerProvidedState(stateUpdate, finalizedUtterance, currentState = {}) {
  const values = stateUpdate?.collectedInformation ?? {};
  const current = currentState?.collectedInformation ?? currentState?.collectedData ?? {};
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(current, key) && sameValue(current[key], value)) continue;
    if (!callerSupportsValue(value, finalizedUtterance)) {
      return Object.freeze({ valid: false, reason: 'unsupported_caller_value', field: key });
    }
  }
  return Object.freeze({ valid: true });
}

export function rankRelevantHydratedEvidence(query, envelope, authoritativeSources = []) {
  const queryTokens = tokens(query);
  const normalizedQuery = identity(query);
  return (envelope?.sources ?? []).map((source, index) => {
    const hydrated = authoritativeSources.find((candidate) => (
      candidate.id === source.id || (source.recordId && candidate.recordId === source.recordId)
    ));
    if (!hydrated) return null;
    if (hydrated.callerFacing === false) return null;
    const content = sourceContent(hydrated);
    const contentIdentity = identity(content);
    const contentTokens = new Set(tokens(content));
    const coverage = queryTokens.length
      ? queryTokens.filter((token) => contentTokens.has(token)).length / queryTokens.length
      : 0;
    const exact = normalizedQuery.length >= 3 && contentIdentity.includes(normalizedQuery) ? 1 : 0;
    const retrievalScore = Number(hydrated.score ?? source.evidenceScore ?? 0);
    const retrievalRank = Number(hydrated.rank ?? source.evidenceRank ?? index + 1);
    const exactCallerResponse = source.exactCallerResponse === true;
    return {
      source: hydrated,
      score: exact * 10_000 + (exactCallerResponse ? 5_000 : 0)
        + coverage * 1_000 + Math.max(0, retrievalScore) * 10
        + Math.max(0, 20 - retrievalRank) - index / 100,
      lexicalCoverage: coverage,
      exactCallerResponse,
    };
  }).filter((candidate) => {
    if (!candidate) return false;
    // A fallback must have observable latest-turn support. The only
    // exception is a retrieval-selected Conversation Guidance response,
    // whose semantic match is already constrained to the current turn.
    return candidate.lexicalCoverage > 0 || candidate.exactCallerResponse;
  }).sort((left, right) => right.score - left.score);
}
