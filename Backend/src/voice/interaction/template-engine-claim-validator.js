import { AppError } from '../../middleware/errors.js';

export const TEMPLATE_ENGINE_CLAIM_VALIDATOR_VERSION = 3;

export const templateEngineClaimValidationJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze([
    'supported', 'successClaimed', 'requestedFactAddressed', 'reason',
  ]),
  properties: Object.freeze({
    supported: Object.freeze({ type: 'boolean' }),
    successClaimed: Object.freeze({ type: 'boolean' }),
    requestedFactAddressed: Object.freeze({ type: 'boolean' }),
    reason: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'string' }),
        Object.freeze({ type: 'null' }),
      ]),
    }),
  }),
});

function parsed(value) {
  const candidate = value?.outputParsed ?? value?.output_parsed ?? value?.parsed
    ?? value?.output ?? value;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  if (typeof candidate !== 'string') return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function cleanText(value, maximum = 8_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return cleanText(value).toLocaleLowerCase()
    .replace(/([^\p{L}\p{M}\p{N}])+/gu, ' ').trim();
}

function tokens(value) {
  return new Set(identity(value).split(/\s+/u).filter((token) => token.length > 1));
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function tokenCoverageForFact(value, factTokens) {
  return intersects(tokens(value), factTokens);
}

function scalarFacts(value, path = '', depth = 0, result = []) {
  if (value === null || value === undefined || depth > 6 || result.length >= 300) return result;
  if (Array.isArray(value)) {
    for (const entry of value) scalarFacts(entry, path, depth + 1, result);
  } else if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      scalarFacts(entry, path ? `${path}.${key}` : key, depth + 1, result);
    }
  } else {
    result.push(Object.freeze({ path, value: cleanText(value, 1_000) }));
  }
  return result;
}

function responseContainsValue(responseIdentity, value) {
  const normalized = identity(value);
  return normalized.length > 1 && responseIdentity.includes(normalized);
}

function numbers(value) {
  return new Set(cleanText(value).match(/[+-]?\p{N}+(?:[.,]\p{N}+)?/gu) ?? []);
}

export function validateTemplateEngineSearchClaims({
  speech, evidence = [], decision = null, searchInterpretation = null,
} = {}) {
  const response = cleanText(speech);
  const records = Array.isArray(evidence) ? evidence : [];
  const requestedFact = cleanText(searchInterpretation?.requestedFact, 500);
  if (decision === 'CLARIFY') {
    return Object.freeze({
      supported: Boolean(response), successClaimed: false,
      requestedFactAddressed: true, reason: response ? null : 'empty_clarification',
    });
  }
  if (decision === 'NO_MATCH') {
    return Object.freeze({
      supported: Boolean(response), successClaimed: false,
      requestedFactAddressed: true, reason: response ? null : 'empty_no_match',
    });
  }
  if (decision === 'RESPONSE' && response && !records.length && !searchInterpretation) {
    return Object.freeze({
      supported: true, successClaimed: false, requestedFactAddressed: true, reason: null,
    });
  }
  if (decision !== 'RESPONSE' || !response || !records.length) {
    return Object.freeze({
      supported: false, successClaimed: false, requestedFactAddressed: !requestedFact,
      reason: !records.length ? 'verified_evidence_required' : 'empty_response',
    });
  }
  if (!requestedFact) {
    return Object.freeze({
      supported: true, successClaimed: false, requestedFactAddressed: true, reason: null,
    });
  }

  const factTokens = tokens(requestedFact);
  const responseIdentity = identity(response);
  const responseTokens = tokens(response);
  const facts = records.flatMap((record) => scalarFacts(record?.authoritativeData ?? {}));
  const matchingFacts = facts.filter((fact) => intersects(tokens(fact.path), factTokens));
  const evidenceMentionsFact = records.some((record) => intersects(tokens([
    record?.requestedFact, record?.content, ...(record?.publishedAttributePaths ?? []),
  ].join(' ')), factTokens));
  const taggedForRequestedFact = records.some((record) => (
    tokenCoverageForFact(record?.requestedFact, factTokens)
  ));
  const responseNumbers = numbers(response);
  const evidenceNumbers = numbers(records.map((record) => record?.content).join(' '));
  const citesTaggedNumericValue = taggedForRequestedFact
    && [...responseNumbers].some((number) => evidenceNumbers.has(number));
  const requestedFactAddressed = intersects(responseTokens, factTokens)
    || matchingFacts.some((fact) => responseContainsValue(responseIdentity, fact.value))
    || citesTaggedNumericValue;
  return Object.freeze({
    supported: evidenceMentionsFact,
    successClaimed: false,
    requestedFactAddressed,
    reason: !evidenceMentionsFact
      ? 'requested_fact_not_in_evidence'
      : (requestedFactAddressed ? null : 'requested_fact_not_addressed'),
  });
}

export async function validateTemplateEngineClaims({
  speech, evidence = null, verifiedToolResult = null, callerValues = null,
  decision = null, searchInterpretation = null, latestUtterance = null,
} = {}, dependencies = {}) {
  if (typeof dependencies.invokeStructuredLlm !== 'function') {
    throw new TypeError('Claim validation requires the configured structured LLM');
  }
  const reference = verifiedToolResult
    ? { kind: 'verified_tool_result', verifiedToolResult, callerValues }
    : { kind: 'published_evidence', evidence, searchInterpretation, latestUtterance };
  const completion = await dependencies.invokeStructuredLlm(Object.freeze({
    messages: Object.freeze([Object.freeze({
      role: 'system',
      content: [
        'Validate caller-facing speech against only the supplied reference JSON.',
        'Non-factual conversational speech such as a greeting, acknowledgement, courtesy response, pause handling or presence check may be supported without published evidence.',
        'Any tenant or business fact, including identities, available options, names, descriptions, policies, numbers, attributes or relationships, is unsupported when no published evidence is supplied.',
        'Treat the complete published evidence array as one permitted grounding set.',
        'A comparison may combine separately supported attributes from multiple cited records.',
        'supported is true only when every entity, number, attribute, polarity and relationship is directly entailed by the complete reference set.',
        'For RESPONSE, an attribute absent from every supplied published record is unsupported. Never infer a negative value from an absent attribute.',
        'For a factual RESPONSE with searchInterpretation.requestedFact, requestedFactAddressed is true only when the speech directly answers that requested fact. A true statement about a different supplied attribute is supported but does not address the requested fact.',
        'For CLARIFY, requestedFactAddressed is true only when the question resolves a genuine ambiguity that prevents answering the requested fact.',
        'For NO_MATCH, requestedFactAddressed is true only when the speech neutrally says that the supplied evidence does not provide the requested fact.',
        'If the supplied evidence does contain and answer the requested fact, NO_MATCH is unsupported and requestedFactAddressed must be false.',
        'When no requestedFact is supplied, set requestedFactAddressed to true.',
        'For CLARIFY, validate every factual statement in the question and every named candidate against the supplied reference.',
        'For NO_MATCH, allow a neutral statement that the supplied published information does not contain the requested detail. Reject speech that turns missing evidence into a real-world negative claim, including claims that something does not exist, is unavailable, is unnecessary, is not included, or is zero.',
        'Do not require one evidence record to contain every compared entity when each cited record supports its own entity and attributes.',
        'For a tool result, successClaimed is true when the speech says or implies the action succeeded.',
        'Do not use outside knowledge. Return only the required JSON object.',
        '<validation_input>',
        JSON.stringify({ decision, speech, reference }),
        '</validation_input>',
      ].join('\n'),
    })]),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema', name: 'template_engine_claim_validation', strict: true,
      schema: templateEngineClaimValidationJsonSchema,
    }),
  }));
  const result = parsed(completion);
  if (!result || typeof result.supported !== 'boolean'
    || typeof result.successClaimed !== 'boolean'
    || typeof result.requestedFactAddressed !== 'boolean'
    || !(typeof result.reason === 'string' || result.reason === null)) {
    throw new AppError(502, 'The grounding validator returned an invalid decision',
      'TEMPLATE_ENGINE_CLAIM_VALIDATION_INVALID');
  }
  return Object.freeze({
    supported: result.supported,
    successClaimed: result.successClaimed,
    requestedFactAddressed: result.requestedFactAddressed,
    reason: result.reason,
  });
}
