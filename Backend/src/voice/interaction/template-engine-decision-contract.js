export const TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION = 3;

export const templateEngineDecisionTypes = Object.freeze({
  RESPONSE: 'RESPONSE',
  CLARIFY: 'CLARIFY',
  SEARCH: 'SEARCH',
  TOOL: 'TOOL',
});

const decisionTypes = new Set(Object.values(templateEngineDecisionTypes));
const rootKeys = Object.freeze([
  'decision', 'response', 'clarification', 'search', 'tool', 'nextQuestion', 'stateUpdate',
]);
const clarificationKeys = Object.freeze(['question', 'reason', 'candidates']);
const nextQuestionKeys = Object.freeze(['question', 'reason']);
const searchRequiredKeys = Object.freeze(['query', 'requestedFact', 'contextualReference']);
const searchKeys = Object.freeze([...searchRequiredKeys, 'preferredRecordIds']);
const toolKeys = Object.freeze(['name', 'arguments']);
const stateUpdateKeys = Object.freeze(['set', 'clear']);
const clearableStateKeys = Object.freeze([
  'lastReferencedRecordIds', 'comparisonRecordIds', 'pendingClarification',
  'activeWorkflowId', 'collectedToolFields', 'confirmationStatus',
]);

// OpenAI-compatible strict structured output supports only a bounded JSON Schema
// subset. Length/item constraints and open-ended objects are enforced below by
// the runtime validator instead of being sent to the provider.
const nullableTextSchema = Object.freeze({
  anyOf: Object.freeze([
    Object.freeze({ type: 'string' }),
    Object.freeze({ type: 'null' }),
  ]),
});

export const templateEngineDecisionJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: rootKeys,
  properties: Object.freeze({
    decision: Object.freeze({
      type: 'string', enum: Object.values(templateEngineDecisionTypes),
    }),
    response: Object.freeze({ type: 'string' }),
    clarification: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: clarificationKeys,
          properties: Object.freeze({
            question: Object.freeze({ type: 'string' }),
            reason: nullableTextSchema,
            candidates: Object.freeze({
              type: 'array', items: Object.freeze({ type: 'string' }),
            }),
          }),
        }),
      ]),
    }),
    search: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: searchKeys,
          properties: Object.freeze({
            query: Object.freeze({ type: 'string' }),
            requestedFact: nullableTextSchema,
            contextualReference: nullableTextSchema,
            preferredRecordIds: Object.freeze({
              type: 'array', items: Object.freeze({ type: 'string' }),
            }),
          }),
        }),
      ]),
    }),
    tool: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: toolKeys,
          properties: Object.freeze({
            name: Object.freeze({ type: 'string' }),
            // Dynamic UI tool fields cannot be represented as an unrestricted
            // object in a strict provider schema. The provider returns JSON in
            // this string and normalizeTool parses it before authorization.
            arguments: Object.freeze({ type: 'string' }),
          }),
        }),
      ]),
    }),
    nextQuestion: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: nextQuestionKeys,
          properties: Object.freeze({
            question: Object.freeze({ type: 'string' }),
            reason: nullableTextSchema,
          }),
        }),
      ]),
    }),
    stateUpdate: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: stateUpdateKeys,
          properties: Object.freeze({
            set: Object.freeze({
              type: 'object',
              additionalProperties: false,
              required: Object.freeze(['confirmationStatus']),
              properties: Object.freeze({
                confirmationStatus: Object.freeze({
                  anyOf: Object.freeze([
                    Object.freeze({ type: 'string', enum: ['confirmed'] }),
                    Object.freeze({ type: 'null' }),
                  ]),
                }),
              }),
            }),
            clear: Object.freeze({
              type: 'array', items: Object.freeze({
                type: 'string', enum: clearableStateKeys,
              }),
            }),
          }),
        }),
      ]),
    }),
  }),
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

function normalizeNextQuestion(value) {
  if (!hasExactKeys(value, nextQuestionKeys)) return null;
  const question = cleanText(value.question, 1_000);
  const reason = nullableText(value.reason);
  if (!question || (value.reason !== null && reason === null)) return null;
  return Object.freeze({ question, reason });
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
  let rawArguments = value.arguments;
  if (typeof rawArguments === 'string') {
    try { rawArguments = JSON.parse(rawArguments); } catch { return null; }
  }
  const argumentsObject = jsonSafeObject(rawArguments);
  return name && argumentsObject ? Object.freeze({ name, arguments: argumentsObject }) : null;
}

function normalizeStateUpdate(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, stateUpdateKeys) || !Array.isArray(value.clear)
    || value.clear.length > 50) return undefined;
  const set = jsonSafeObject(value.set);
  const clear = value.clear.map((key) => cleanText(key, 160));
  if (!set || Object.keys(set).some((key) => key !== 'confirmationStatus')
    || (Object.hasOwn(set, 'confirmationStatus')
      && !['confirmed', null].includes(set.confirmationStatus))
    || clear.some((key) => !key || !clearableStateKeys.includes(key))
    || new Set(clear).size !== clear.length) return undefined;
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
  const nextQuestion = parsed.nextQuestion === null
    ? null : normalizeNextQuestion(parsed.nextQuestion);
  const stateUpdate = normalizeStateUpdate(parsed.stateUpdate);
  if ((parsed.clarification !== null && !clarification)
    || (parsed.search !== null && !search)
    || (parsed.tool !== null && !tool)
    || (parsed.nextQuestion !== null && !nextQuestion)
    || stateUpdate === undefined) {
    return Object.freeze({ valid: false, reason: 'invalid_payload' });
  }

  const branchValid = ({
    RESPONSE: Boolean(response) && clarification === null && search === null && tool === null,
    CLARIFY: response === '' && clarification !== null && search === null && tool === null
      && nextQuestion === null,
    SEARCH: response === '' && clarification === null && search !== null && tool === null
      && nextQuestion === null,
    TOOL: response === '' && clarification === null && search === null && tool !== null
      && nextQuestion === null,
  })[parsed.decision];
  if (!branchValid) return Object.freeze({ valid: false, reason: 'mixed_decision_payload' });

  const clearsWorkflow = stateUpdate?.clear.includes('activeWorkflowId') === true;
  if (clearsWorkflow) {
    const requiredClears = ['activeWorkflowId', 'collectedToolFields', 'confirmationStatus'];
    if (parsed.decision !== 'RESPONSE' || nextQuestion !== null
      || stateUpdate.set.confirmationStatus !== null
      || requiredClears.some((key) => !stateUpdate.clear.includes(key))) {
      return Object.freeze({ valid: false, reason: 'invalid_workflow_cancellation' });
    }
  }

  return Object.freeze({
    valid: true,
    value: Object.freeze({
      decision: parsed.decision,
      response,
      clarification,
      search,
      tool,
      nextQuestion,
      stateUpdate,
    }),
  });
}
