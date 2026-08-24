import { groundedNumbers as numbers } from './grounded-number-validator.js';

const maximumText = 8_000;
const maximumEvidenceText = 32_000;

function text(value, maximum = maximumText) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return text(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function tokens(value) {
  return identity(value).split(' ').filter((token) => token.length >= 3 || /\d/u.test(token));
}

function sourceContent(source) {
  let structured = '';
  try {
    const data = source?.authoritativeData;
    if (data && typeof data === 'object') {
      const priorityKeys = [
        'attributes', 'tests', 'services', 'consultations', 'benefits',
        'preparation', 'price', 'currency', 'relationships', 'selectionRules',
        'availability', 'sourceText',
      ];
      const orderedEntries = [
        ...priorityKeys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]),
        ...Object.entries(data).filter(([key]) => !priorityKeys.includes(key)),
      ];
      structured = JSON.stringify(Object.fromEntries(orderedEntries));
    }
  } catch {
    structured = '';
  }
  // Structured PostgreSQL fields are the canonical fact projection. Keep
  // them before a potentially long source narrative so bounded validators
  // cannot truncate attributes such as tests, prices or services.
  return `${text(structured, maximumEvidenceText)} ${text(source?.content, maximumEvidenceText)}`.trim();
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

const actionSuccessPattern = /(?:\b(?:confirmed|completed|successful|successfully|booked|scheduled|sent|transferred|created|updated|cancelled|refunded|reserved)\b|\u0B86\u0B95\u0BBF\u0BB5\u0BBF\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1|\u0BAE\u0BC1\u0B9F\u0BBF\u0BA8\u0BCD\u0BA4\u0BC1\u0BB5\u0BBF\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1|\b(?:confirm|book|schedule|send|transfer|complete)\s+(?:aagiduchu|ayiduchu|panniyachu|panniten)\b)/iu;
const actionObjectPattern = /\b(?:action|appointment|booking|callback|case|message|order|payment|refund|request|reservation|ticket|transfer|tool)\b/iu;
const internalGuidancePattern = /(?:grounded[_ ]response|evidenceids|stateupdate|toolrequest|runtime context|system prompt|response[_ ]mode|action[_ ]config|\bcaller\s+(?:asked|requested|said|\u0B95\u0BC7\u0B9F\u0BCD\u0B9F)|\b(?:retrieve|rank|hydrate|validate)\s+(?:the\s+)?(?:approved|evidence|record)|\b(?:must|should)\s+(?:ask|answer|retrieve|use|resume|execute|transfer))/iu;
const medicalAssertions = Object.freeze({
  diagnosis: /(?:\bdiagnos(?:e|ed|es|is)\b|\u0BA8\u0BCB\u0BAF\u0BC8\s*\u0B89\u0BB1\u0BC1\u0BA4\u0BBF|\bdiagnos(?:e|is)\s+pann)/iu,
  cure: /(?:\bcure[sd]?\b|\u0B95\u0BC1\u0BA3\u0BAE\u0BBE\u0B95\u0BCD\u0B95|\bcure\s+pann)/iu,
  treatment: /(?:\btreat(?:s|ed|ment)?\b|\bprescrib(?:e|ed|es)?\b|\btreat\s+pann)/iu,
  detection: /(?:\bdetect(?:s|ed|ion)?\b|\u0B95\u0BA3\u0BCD\u0B9F\u0BC1\u0BAA\u0BBF\u0B9F\u0BBF\u0B95\u0BCD\u0B95|\bdetect\s+pann)/iu,
  prevention: /(?:\bprevent(?:s|ed|ion)?\b|\bprevent\s+pann)/iu,
  rule_out: /\brule[sd]?\s+out\b/iu,
  suitability: /(?:\bmedically\s+suitable\b|\bsuitable\s+(?:pann|aag|irukk))/iu,
  guarantee: /\bguarantee[sd]?\b/iu,
});
const medicalAdvice = Object.freeze({
  start: /\b(?:start|take|increase|recommend|prescribe)\b[^.!?]{0,80}\b(?:medicine|medication|tablet|dose|dosage|drug|treatment)\b/iu,
  stop: /\b(?:stop|avoid|decrease|change)\b[^.!?]{0,80}\b(?:medicine|medication|tablet|dose|dosage|drug|treatment)\b/iu,
});
const unsupportedRecommendationPattern = /(?:\b(?:recommend(?:ed|ation)?|best|ideal|appropriate|suitable)\b|\bright\s+(?:choice|option|fit)\b|\bshould\s+(?:choose|select|book|take|use|go\s+for)\b|\b(?:choose|select|book|take|use)\s+this\b|\b(?:recommend|suitable|best)\s+(?:pann|aag|irukk)\b)/iu;
const recommendationRefusalPattern = /(?:\b(?:cannot|can't|can\s+not|do\s+not|don't|unable\s+to|not\s+able\s+to)\s+(?:recommend|determine|say|choose|select)\b|\bnot\s+(?:enough|authorized)\s+(?:information\s+)?to\s+(?:recommend|determine|choose|select)\b)/iu;
const medicalConcernPattern = /(?:\b(?:symptom|pain|fever|cough|breath(?:ing|lessness)?|condition|disease|diagnos|medical|health\s+(?:issue|problem|concern))\b|\b(?:vali|kaichal|irumal|moochu|udambu)\b|\u0BA8\u0BCB\u0BAF\u0BCD|\u0BB5\u0BB2\u0BBF|\u0B95\u0BBE\u0BAF\u0BCD\u0B9A\u0BCD\u0B9A\u0BB2\u0BCD|\u0B87\u0BB0\u0BC1\u0BAE\u0BB2\u0BCD|\u0BAE\u0BC2\u0B9A\u0BCD\u0B9A\u0BC1)/iu;
const explicitRecommendationSupportPattern = /(?:\b(?:recommend(?:ed|ation)?|suitable|suitability|appropriate|eligib(?:le|ility)|selection\s+rule|best\s+for|intended\s+for)\b|\b(?:recommend|suitable)\s+(?:pann|aag|irukk)\b)/iu;
const negativeFactPattern = /(?:\b(?:is|are|was|were)\s+not\s+(?:available|included|offered|provided|supported|selectable)\b|\b(?:does|do|did)\s+not\s+(?:include|offer|provide|support|allow)\b|\bwithout\s+(?:a\s+)?(?:test|service|consultation|benefit|feature)\b|\b(?:unavailable|excluded|unsupported|not\s+selectable)\b|\b(?:available|include|offer|provide|support)\s+(?:illa|illai|kidayathu)\b|\u0B87\u0BB2\u0BCD\u0BB2\u0BC8|\u0B95\u0BBF\u0B9F\u0BC8\u0BAF\u0BBE\u0BA4\u0BC1)/iu;
const positiveFactPattern = /(?:\b(?:is|are|was|were)\s+(?:available|included|offered|provided|supported|selectable)\b|\b(?:includes?|offers?|provides?|supports?|allows?)\b|\b(?:available|include|offer|provide|support)\s+(?:irukku|undu|yes)\b|\u0B95\u0BBF\u0B9F\u0BC8\u0B95\u0BCD\u0B95\u0BC1\u0BAE\u0BCD|\u0B89\u0BB3\u0BCD\u0BB3\u0BA4\u0BC1)/iu;

function unsupportedStructuredIdentifiers(claim, evidenceText) {
  // Catalog values may arrive with presentation casing (for example `Cbc`
  // or `rbs`) even though the model naturally speaks their abbreviations in
  // uppercase. Compare claimed identifiers against all normalized evidence
  // tokens case-insensitively. Require complete hyphen segments so `X-Ray`
  // cannot be misread as the invalid identifier `X-`.
  const normalizedEvidence = text(evidenceText, maximumEvidenceText)
    .toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const compactEvidence = normalizedEvidence.replace(/\s+/gu, '');
  const evidence = new Set(normalizedEvidence.split(' ')
    .filter((entry) => entry.length >= 2 || /\d/u.test(entry))
    .map((entry) => entry.toLocaleUpperCase()));
  const claimed = (String(claim).match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/gu) ?? [])
    .filter((entry) => entry.replace(/-/gu, '').length >= 2)
    .map((entry) => entry.toLocaleUpperCase());
  return [...new Set(claimed)].filter((entry) => {
    if (evidence.has(entry)) return false;
    const normalizedIdentifier = identity(entry);
    if (normalizedIdentifier && ` ${normalizedEvidence} `.includes(` ${normalizedIdentifier} `)) return false;
    const compactIdentifier = normalizedIdentifier.replace(/\s+/gu, '');
    return !compactIdentifier || !compactEvidence.includes(compactIdentifier);
  });
}

function matchedPolicyTypes(value, policies) {
  return new Set(Object.entries(policies).filter(([, pattern]) => pattern.test(value)).map(([key]) => key));
}

function typesSupportedByEvidence(claimTypes, evidenceText, policies) {
  if (!claimTypes.size) return true;
  const supported = matchedPolicyTypes(evidenceText, policies);
  return [...claimTypes].every((type) => supported.has(type));
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
  const evidenceNumbers = numbers(evidenceText);
  const unsupportedNumbers = [...numbers(claim)].filter((number) => !evidenceNumbers.has(number));
  if (unsupportedNumbers.length) {
    return Object.freeze({
      valid: false, reason: 'unsupported_numeric_fact',
      numbers: Object.freeze(unsupportedNumbers),
    });
  }
  const unsupportedIdentifiers = unsupportedStructuredIdentifiers(claim, evidenceText);
  if (unsupportedIdentifiers.length) {
    return Object.freeze({
      valid: false, reason: 'unsupported_structured_fact', identifiers: unsupportedIdentifiers,
    });
  }
  const selectedCatalogIdentities = new Set(sources.flatMap((source) => {
    const data = source?.authoritativeData ?? {};
    return [source?.recordId, data.itemKey, data.name, data.categoryKey, data.category]
      .map(identity).filter(Boolean);
  }));
  const unsupportedEntity = (options.knownEntities ?? []).find((entity) => {
    const candidates = [entity?.id, entity?.key, entity?.name].map(identity).filter(Boolean);
    const mentioned = candidates.some((candidate) => candidate.length >= 3 && identity(claim).includes(candidate));
    return mentioned && !candidates.some((candidate) => selectedCatalogIdentities.has(candidate));
  });
  if (unsupportedEntity) {
    return Object.freeze({ valid: false, reason: 'unsupported_entity', entity: unsupportedEntity.key ?? unsupportedEntity.name });
  }
  if (claimsActionSuccess(claim)
    && !sources.some(verifiedActionSource)
    && options.allowVerifiedActionClaim !== true) {
    return Object.freeze({ valid: false, reason: 'unauthorized_action_claim' });
  }
  const medicalClaimTypes = matchedPolicyTypes(claim, medicalAssertions);
  if (!typesSupportedByEvidence(medicalClaimTypes, evidenceText, medicalAssertions)) {
    return Object.freeze({ valid: false, reason: 'unsupported_medical_claim' });
  }
  const medicalAdviceTypes = matchedPolicyTypes(claim, medicalAdvice);
  if (!typesSupportedByEvidence(medicalAdviceTypes, evidenceText, medicalAdvice)) {
    return Object.freeze({ valid: false, reason: 'unsupported_medical_advice' });
  }
  const makesRecommendation = unsupportedRecommendationPattern.test(claim)
    && !recommendationRefusalPattern.test(claim);
  if (makesRecommendation
    && medicalConcernPattern.test(text(options.finalizedUtterance))) {
    const explicitlySupported = explicitRecommendationSupportPattern.test(evidenceText);
    if (!explicitlySupported) {
      return Object.freeze({ valid: false, reason: 'unsupported_suitability_recommendation' });
    }
  }
  if (makesRecommendation
    && !explicitRecommendationSupportPattern.test(evidenceText)) {
    return Object.freeze({ valid: false, reason: 'unsupported_recommendation' });
  }
  if (negativeFactPattern.test(claim) && !negativeFactPattern.test(evidenceText)) {
    return Object.freeze({ valid: false, reason: 'unsupported_claim_polarity' });
  }
  if (positiveFactPattern.test(claim) && negativeFactPattern.test(evidenceText)
    && !positiveFactPattern.test(evidenceText)) {
    return Object.freeze({ valid: false, reason: 'unsupported_claim_polarity' });
  }
  return Object.freeze({
    valid: true,
    validatedBy: Object.freeze([
      'selected_evidence', 'canonical_entities', 'exact_numbers',
      'catalog_attributes', 'claim_polarity', 'recommendation_policy',
      'medical_policy', 'action_authorization',
    ]),
  });
}

export function validateGroundedClaims(value, sources = [], options = {}) {
  for (const sentence of sentences(value)) {
    const result = validateGroundedClaim(sentence, sources, options);
    if (!result.valid) return Object.freeze({ ...result, sentence });
  }
  return Object.freeze({ valid: true });
}

export function removeUnsupportedRecommendationSentences(value, sources = [], options = {}) {
  const kept = [];
  const removed = [];
  for (const sentence of sentences(value)) {
    const result = validateGroundedClaim(sentence, sources, options);
    if (!result.valid && result.reason === 'unsupported_recommendation') removed.push(sentence);
    else kept.push(sentence);
  }
  return Object.freeze({
    answer: kept.join(' ').trim(),
    removed: Object.freeze(removed),
  });
}

export function hydrateSelectedEvidence(decision, envelope, authoritativeSources = []) {
  const selected = new Set([
    ...(decision?.evidenceIds ?? []),
    ...(decision?.evidenceSourceIds ?? []),
  ]);
  return (envelope?.sources ?? []).filter((source) => selected.has(source.id)).map((source) => (
    authoritativeSources.find((candidate) => (
      candidate.id === source.publishedEvidenceId
      || candidate.id === source.id
      || (source.recordId && candidate.recordId === source.recordId)
    )) ?? null
  )).filter(Boolean);
}

export function hydrateGroundingEnvelope(envelope, authoritativeSources = []) {
  const sources = (envelope?.sources ?? []).map((source) => {
    const authoritative = authoritativeSources.find((candidate) => (
      candidate.id === source.publishedEvidenceId
      || candidate.id === source.id
      || (source.recordId && candidate.recordId === source.recordId)
    ));
    return authoritative ? Object.freeze({
      ...source, ...authoritative,
      // The envelope may explicitly mark the retrieval-selected guidance
      // RESPONSE as caller-facing; authoritative metadata still controls all
      // tenant/revision identity and factual fields.
      callerFacing: source.callerFacing === true ? true : authoritative.callerFacing,
      id: source.id,
      publishedEvidenceId: authoritative.id,
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
