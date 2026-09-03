export const templateEnginePostSearchDecisionTypes = Object.freeze({
  RESPONSE: 'RESPONSE',
  CLARIFY: 'CLARIFY',
  NO_MATCH: 'NO_MATCH',
});

const rootKeys = Object.freeze([
  'decision', 'response', 'clarification', 'evidenceIds', 'stateUpdate',
]);
const clarificationKeys = Object.freeze(['question', 'reason', 'candidates']);
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
    // Post-search state is derived deterministically from citations and
    // clarification output; the LLM cannot write arbitrary state here.
    stateUpdate: Object.freeze({ type: 'null' }),
  }),
});

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

export function validateTemplateEnginePostSearchDecision(value, allowedEvidenceIds = []) {
  const parsed = parse(value);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  if (!exactKeys(parsed, rootKeys)) return Object.freeze({ valid: false, reason: 'invalid_shape' });
  if (!decisions.has(parsed.decision)) {
    return Object.freeze({ valid: false, reason: 'invalid_decision' });
  }
  const response = text(parsed.response, 4_000);
  const clarification = parsed.clarification === null
    ? null : normalizeClarification(parsed.clarification);
  const evidenceIds = Array.isArray(parsed.evidenceIds)
    ? parsed.evidenceIds.map((id) => text(id, 160)) : null;
  const stateUpdate = parsed.stateUpdate === null ? null : undefined;
  if (response === null || (parsed.clarification !== null && !clarification)
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
    CLARIFY: response === '' && clarification !== null && evidenceIds.length === 0,
    NO_MATCH: Boolean(response) && clarification === null && evidenceIds.length === 0,
  })[parsed.decision];
  if (!branchValid) return Object.freeze({ valid: false, reason: 'mixed_decision_payload' });
  return Object.freeze({
    valid: true,
    value: Object.freeze({
      decision: parsed.decision, response, clarification,
      evidenceIds: Object.freeze(evidenceIds), stateUpdate,
    }),
  });
}
