export const TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION = 1;

export const templateEngineDecisionTypes = Object.freeze({
  RESPONSE: 'RESPONSE',
  CLARIFY: 'CLARIFY',
  SEARCH: 'SEARCH',
  TOOL: 'TOOL',
});

const decisionTypes = new Set(Object.values(templateEngineDecisionTypes));
const rootKeys = Object.freeze([
  'decision', 'response', 'clarification', 'search', 'tool', 'stateUpdate',
]);
const clarificationKeys = Object.freeze(['question', 'reason', 'candidates']);
const searchRequiredKeys = Object.freeze(['query', 'requestedFact', 'contextualReference']);
const searchKeys = Object.freeze([...searchRequiredKeys, 'preferredRecordIds']);
const toolKeys = Object.freeze(['name', 'arguments']);
const stateUpdateKeys = Object.freeze(['set', 'clear']);

const nullableTextSchema = Object.freeze({ type: ['string', 'null'], maxLength: 500 });

export const templateEngineDecisionJsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'TemplateEngineDecision',
  type: 'object',
  additionalProperties: false,
  required: rootKeys,
  properties: Object.freeze({
    decision: Object.freeze({ enum: Object.values(templateEngineDecisionTypes) }),
    response: Object.freeze({ type: 'string', maxLength: 4_000 }),
    clarification: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: clarificationKeys,
          properties: Object.freeze({
            question: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_000 }),
            reason: nullableTextSchema,
            candidates: Object.freeze({
              type: 'array', maxItems: 10, uniqueItems: true,
              items: Object.freeze({ type: 'string', minLength: 1, maxLength: 300 }),
            }),
          }),
        }),
      ]),
    }),
    search: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: searchKeys,
          properties: Object.freeze({
            query: Object.freeze({ type: 'string', minLength: 1, maxLength: 2_000 }),
            requestedFact: nullableTextSchema,
            contextualReference: nullableTextSchema,
            preferredRecordIds: Object.freeze({
              type: 'array', maxItems: 20, uniqueItems: true,
              items: Object.freeze({ type: 'string', minLength: 1, maxLength: 160 }),
            }),
          }),
        }),
      ]),
    }),
    tool: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: toolKeys,
          properties: Object.freeze({
            name: Object.freeze({ type: 'string', minLength: 1, maxLength: 160 }),
            arguments: Object.freeze({ type: 'object' }),
          }),
        }),
      ]),
    }),
    stateUpdate: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: stateUpdateKeys,
          properties: Object.freeze({
            set: Object.freeze({ type: 'object' }),
            clear: Object.freeze({
              type: 'array', maxItems: 50, uniqueItems: true,
              items: Object.freeze({ type: 'string', minLength: 1, maxLength: 160 }),
            }),
          }),
        }),
      ]),
    }),
  }),
  allOf: Object.freeze(Object.values(templateEngineDecisionTypes).map((decision) => {
    const activeProperty = ({
      RESPONSE: 'response', CLARIFY: 'clarification', SEARCH: 'search', TOOL: 'tool',
    })[decision];
    const inactiveProperties = ['clarification', 'search', 'tool']
      .filter((property) => property !== activeProperty);
    return Object.freeze({
      if: Object.freeze({ properties: Object.freeze({ decision: Object.freeze({ const: decision }) }) }),
      then: Object.freeze({
        properties: Object.freeze({
          response: decision === 'RESPONSE'
            ? Object.freeze({ type: 'string', minLength: 1 })
            : Object.freeze({ const: '' }),
          ...Object.fromEntries(inactiveProperties.map((property) => [
            property, Object.freeze({ type: 'null' }),
          ])),
          ...(activeProperty !== 'response'
            ? { [activeProperty]: Object.freeze({ type: 'object' }) } : {}),
        }),
      }),
    });
  })),
});

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).sort().join('|') === [...expected].sort().join('|');
}

function hasOnlyKeysAndRequired(value, allowed, required) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function cleanText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return normalized.length <= maximum ? normalized : null;
}

function nullableText(value, maximum = 500) {
  return value === null ? null : cleanText(value, maximum);
}

function normalizeClarification(value) {
  if (!hasExactKeys(value, clarificationKeys)) return null;
  const question = cleanText(value.question, 1_000);
  const reason = nullableText(value.reason);
  if (!question || (value.reason !== null && reason === null) || !Array.isArray(value.candidates)
    || value.candidates.length > 10) return null;
  const candidates = value.candidates.map((candidate) => cleanText(candidate, 300));
  if (candidates.some((candidate) => !candidate) || new Set(candidates).size !== candidates.length) {
    return null;
  }
  return Object.freeze({ question, reason, candidates: Object.freeze(candidates) });
}

function normalizeSearch(value) {
  if (!hasOnlyKeysAndRequired(value, searchKeys, searchRequiredKeys)) return null;
  const query = cleanText(value.query, 2_000);
  const requestedFact = nullableText(value.requestedFact);
  const contextualReference = nullableText(value.contextualReference);
  const suppliedRecordIds = value.preferredRecordIds ?? [];
  if (!Array.isArray(suppliedRecordIds) || suppliedRecordIds.length > 20) return null;
  const preferredRecordIds = suppliedRecordIds.map((recordId) => cleanText(recordId, 160));
  if (!query || (value.requestedFact !== null && requestedFact === null)
    || (value.contextualReference !== null && contextualReference === null)
    || preferredRecordIds.some((recordId) => !recordId)
    || new Set(preferredRecordIds).size !== preferredRecordIds.length) return null;
  return Object.freeze({
    query, requestedFact, contextualReference,
    preferredRecordIds: Object.freeze(preferredRecordIds),
  });
}

function jsonSafeObject(value) {
  if (!isObject(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 20_000) return null;
    const parsed = JSON.parse(serialized);
    return isObject(parsed) ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}

function normalizeTool(value) {
  if (!hasExactKeys(value, toolKeys)) return null;
  const name = cleanText(value.name, 160);
  const argumentsObject = jsonSafeObject(value.arguments);
  return name && argumentsObject ? Object.freeze({ name, arguments: argumentsObject }) : null;
}

function normalizeStateUpdate(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, stateUpdateKeys) || !Array.isArray(value.clear)
    || value.clear.length > 50) return undefined;
  const set = jsonSafeObject(value.set);
  const clear = value.clear.map((key) => cleanText(key, 160));
  if (!set || clear.some((key) => !key) || new Set(clear).size !== clear.length) return undefined;
  return Object.freeze({ set, clear: Object.freeze(clear) });
}

function parseStrictObject(value) {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateTemplateEngineDecision(value) {
  const parsed = parseStrictObject(value);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  if (!hasExactKeys(parsed, rootKeys)) {
    return Object.freeze({ valid: false, reason: 'invalid_shape' });
  }
  if (!decisionTypes.has(parsed.decision)) {
    return Object.freeze({ valid: false, reason: 'invalid_decision' });
  }
  const response = cleanText(parsed.response, 4_000);
  if (response === null) return Object.freeze({ valid: false, reason: 'invalid_response' });

  const clarification = parsed.clarification === null
    ? null : normalizeClarification(parsed.clarification);
  const search = parsed.search === null ? null : normalizeSearch(parsed.search);
  const tool = parsed.tool === null ? null : normalizeTool(parsed.tool);
  const stateUpdate = normalizeStateUpdate(parsed.stateUpdate);
  if ((parsed.clarification !== null && !clarification)
    || (parsed.search !== null && !search)
    || (parsed.tool !== null && !tool)
    || stateUpdate === undefined) {
    return Object.freeze({ valid: false, reason: 'invalid_payload' });
  }

  const branchValid = ({
    RESPONSE: Boolean(response) && clarification === null && search === null && tool === null,
    CLARIFY: response === '' && clarification !== null && search === null && tool === null,
    SEARCH: response === '' && clarification === null && search !== null && tool === null,
    TOOL: response === '' && clarification === null && search === null && tool !== null,
  })[parsed.decision];
  if (!branchValid) return Object.freeze({ valid: false, reason: 'mixed_decision_payload' });

  return Object.freeze({
    valid: true,
    value: Object.freeze({
      decision: parsed.decision,
      response,
      clarification,
      search,
      tool,
      stateUpdate,
    }),
  });
}
