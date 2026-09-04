export const templateEnginePostSearchDecisionTypes = Object.freeze({
  RESPONSE: 'RESPONSE',
  CLARIFY: 'CLARIFY',
  NO_MATCH: 'NO_MATCH',
});

const rootKeys = Object.freeze([
  'decision', 'response', 'clarification', 'evidenceIds', 'nextQuestion', 'stateUpdate',
]);
const clarificationKeys = Object.freeze(['question', 'reason', 'candidates']);
const nextQuestionKeys = Object.freeze(['question', 'reason']);
const decisions = new Set(Object.values(templateEnginePostSearchDecisionTypes));

export const templateEnginePostSearchJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: rootKeys,
  properties: Object.freeze({
    decision: Object.freeze({
      type: 'string', enum: Object.values(templateEnginePostSearchDecisionTypes),
    }),
    response: Object.freeze({ type: 'string' }),
    clarification: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object', additionalProperties: false, required: clarificationKeys,
          properties: Object.freeze({
            question: Object.freeze({ type: 'string' }),
            reason: Object.freeze({
              anyOf: Object.freeze([
                Object.freeze({ type: 'string' }),
                Object.freeze({ type: 'null' }),
              ]),
            }),
            candidates: Object.freeze({
              type: 'array', items: Object.freeze({ type: 'string' }),
            }),
          }),
        }),
      ]),
    }),
    evidenceIds: Object.freeze({
      type: 'array', items: Object.freeze({ type: 'string' }),
    }),
    nextQuestion: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object', additionalProperties: false, required: nextQuestionKeys,
          properties: Object.freeze({
            question: Object.freeze({ type: 'string' }),
            reason: Object.freeze({
              anyOf: Object.freeze([
                Object.freeze({ type: 'string' }),
                Object.freeze({ type: 'null' }),
              ]),
            }),
          }),
        }),
      ]),
    }),
    // Post-search state is derived deterministically from citations and
    // clarification output; the LLM cannot write arbitrary state here.
    stateUpdate: Object.freeze({ type: 'null' }),
  }),
});

export function templateEnginePostSearchJsonSchemaForEvidenceAliases(aliases = []) {
  const allowed = [...new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => String(alias ?? '').trim()).filter(Boolean))].slice(0, 5);
  const evidenceItems = allowed.length
    ? Object.freeze({ type: 'string', enum: Object.freeze(allowed) })
    : templateEnginePostSearchJsonSchema.properties.evidenceIds.items;
  return Object.freeze({
    ...templateEnginePostSearchJsonSchema,
    properties: Object.freeze({
      ...templateEnginePostSearchJsonSchema.properties,
      evidenceIds: Object.freeze({
        ...templateEnginePostSearchJsonSchema.properties.evidenceIds,
        items: evidenceItems,
      }),
    }),
  });
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function text(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return normalized.length <= maximum ? normalized : null;
}

function parse(value) {
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

function normalizeClarification(value) {
  if (!exactKeys(value, clarificationKeys)) return null;
  const question = text(value.question, 1_000);
  const reason = value.reason === null ? null : text(value.reason, 500);
  if (!question || (value.reason !== null && reason === null) || !Array.isArray(value.candidates)
    || value.candidates.length > 10) return null;
  const candidates = value.candidates.map((candidate) => text(candidate, 300));
  if (candidates.some((candidate) => !candidate) || new Set(candidates).size !== candidates.length) {
    return null;
  }
  return Object.freeze({ question, reason, candidates: Object.freeze(candidates) });
}

function normalizeNextQuestion(value) {
  if (!exactKeys(value, nextQuestionKeys)) return null;
  const question = text(value.question, 1_000);
  const reason = value.reason === null ? null : text(value.reason, 500);
  if (!question || (value.reason !== null && reason === null)) return null;
  return Object.freeze({ question, reason });
}

function normalizeInactiveBranchFields(parsed) {
  if (!decisions.has(parsed?.decision)) return parsed;
  if (parsed.decision === templateEnginePostSearchDecisionTypes.RESPONSE) {
    return Object.freeze({ ...parsed, clarification: null });
  }
  if (parsed.decision === templateEnginePostSearchDecisionTypes.CLARIFY) {
    return Object.freeze({ ...parsed, response: '', evidenceIds: [], nextQuestion: null });
  }
  return Object.freeze({
    ...parsed, clarification: null, evidenceIds: [], nextQuestion: null,
  });
}

export function templateEnginePostSearchDecisionDiagnostics(value) {
  const parsed = parse(value);
  const evidenceAliases = Array.isArray(parsed?.evidenceIds)
    ? [...new Set(parsed.evidenceIds.filter((id) => (
      typeof id === 'string' && /^E[1-5]$/u.test(id)
    )))].slice(0, 5) : [];
  return Object.freeze({
    parsed: Boolean(parsed),
    decision: decisions.has(parsed?.decision) ? parsed.decision : null,
    responsePresent: typeof parsed?.response === 'string' && parsed.response.trim().length > 0,
    clarificationPresent: isObject(parsed?.clarification),
    nextQuestionPresent: isObject(parsed?.nextQuestion),
    evidenceIdCount: Array.isArray(parsed?.evidenceIds) ? parsed.evidenceIds.length : null,
    evidenceAliases: Object.freeze(evidenceAliases),
    stateUpdateNull: parsed?.stateUpdate === null,
  });
}

export function validateTemplateEnginePostSearchDecision(value, allowedEvidenceIds = []) {
  const received = parse(value);
  if (!received) return Object.freeze({ valid: false, reason: 'invalid_json' });
  if (!exactKeys(received, rootKeys)) return Object.freeze({ valid: false, reason: 'invalid_shape' });
  if (!decisions.has(received.decision)) {
    return Object.freeze({ valid: false, reason: 'invalid_decision' });
  }
  const parsed = normalizeInactiveBranchFields(received);
  const response = text(parsed.response, 4_000);
  const clarification = parsed.clarification === null
    ? null : normalizeClarification(parsed.clarification);
  const evidenceIds = Array.isArray(parsed.evidenceIds)
    ? parsed.evidenceIds.map((id) => text(id, 160)) : null;
  const nextQuestion = parsed.nextQuestion === null
    ? null : normalizeNextQuestion(parsed.nextQuestion);
  const stateUpdate = parsed.stateUpdate === null ? null : undefined;
  if (response === null || (parsed.clarification !== null && !clarification)
    || (parsed.nextQuestion !== null && !nextQuestion)
    || !evidenceIds || evidenceIds.length > 5 || evidenceIds.some((id) => !id)
    || new Set(evidenceIds).size !== evidenceIds.length || stateUpdate === undefined) {
    return Object.freeze({ valid: false, reason: 'invalid_payload' });
  }
  const allowed = new Set(allowedEvidenceIds.map((id) => String(id)));
  if (evidenceIds.some((id) => !allowed.has(id))) {
    return Object.freeze({ valid: false, reason: 'unknown_evidence_id' });
  }
  const branchValid = ({
    RESPONSE: Boolean(response) && clarification === null && evidenceIds.length > 0,
    CLARIFY: response === '' && clarification !== null && evidenceIds.length === 0
      && nextQuestion === null,
    NO_MATCH: Boolean(response) && clarification === null && evidenceIds.length === 0
      && nextQuestion === null,
  })[parsed.decision];
  if (!branchValid) return Object.freeze({ valid: false, reason: 'mixed_decision_payload' });
  return Object.freeze({
    valid: true,
    value: Object.freeze({
      decision: parsed.decision, response, clarification,
      evidenceIds: Object.freeze(evidenceIds), nextQuestion, stateUpdate,
    }),
  });
}
