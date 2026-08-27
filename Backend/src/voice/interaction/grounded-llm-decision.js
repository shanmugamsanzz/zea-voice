import { groundedNumbers as numbers } from './grounded-number-validator.js';

const maximumAnswerCharacters = 4_000;
const maximumSources = 10;
const maximumEntities = 20;
const decisions = new Set(['answer', 'clarify', 'action']);
const externalDecisions = Object.freeze(['RESPONSE', 'TOOL', 'CLARIFY']);

function normalizeDecision(value) {
  const normalized = text(value, 20).toLocaleUpperCase();
  return ({
    RESPONSE: 'answer',
    TOOL: 'action',
    CLARIFY: 'clarify',
    ANSWER: 'answer',
    ACTION: 'action',
  })[normalized] ?? normalized.toLocaleLowerCase();
}
const repairableDecisionReasons = new Set([
  'invalid_json', 'invalid_response_shape', 'invalid_clarification',
  'answer_required', 'unsupported_numeric_fact',
  'unsupported_structured_fact', 'unsupported_technical_term',
  'unsupported_claim_polarity', 'unsupported_recommendation',
  'unsupported_suitability_recommendation',
]);

export function isRepairableGroundedDecisionReason(reason) {
  return repairableDecisionReasons.has(String(reason ?? '').trim());
}
const clarificationReasons = new Set([
  'missing_entity', 'missing_fact', 'authoritative_ambiguity',
  'missing_evidence', 'conflicting_evidence', 'missing_required_information',
  'ambiguous_request',
]);
const exactResponseRequestTypes = new Set([
  'overview', 'options', 'available_options', 'list_options', 'category_overview',
]);

function requestType(value) {
  const normalized = text(value, 64).toLocaleLowerCase().replace(/[\s./-]+/gu, '_');
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : null;
}

function text(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return text(value, 240).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function list(value, maximum = 20) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => text(entry, 160)).filter(Boolean))].slice(0, maximum)
    : [];
}

function inferredClarificationReason(runtime = {}) {
  const context = runtime.clarificationContext ?? {};
  const candidates = Array.isArray(context.ambiguityCandidates)
    ? context.ambiguityCandidates.filter(Boolean) : [];
  if (candidates.length > 1) return 'authoritative_ambiguity';
  const memory = context.canonicalMemory ?? {};
  const hasEntity = Boolean(
    memory.activeEntityId || memory.activeCategoryId || memory.activeEntity?.recordId
    || memory.activeCategory?.recordId,
  );
  if (!hasEntity && context.requestedFact) return 'missing_entity';
  if (hasEntity && !context.requestedFact) return 'missing_fact';
  return 'missing_evidence';
}

function parseObject(value) {
  const raw = String(value ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exactShape(value) {
  const expected = [
    'answer', 'clarification', 'decision', 'evidenceIds', 'pendingQuestion',
    'responseId', 'stateUpdate', 'toolRequest',
  ];
  return Object.keys(value).sort().join('|') === expected.join('|');
}

const decisionEnvelopeKeys = new Set([
  'answer', 'clarification', 'decision', 'evidenceIds', 'pendingQuestion',
  'responseId', 'stateUpdate', 'toolRequest',
  // Compact provider contract. Runtime normalization converts these fields
  // into the established internal envelope before semantic validation.
  'toolName', 'toolArguments', 'clarificationReason',
  // Rolling-provider aliases. They are normalized into evidenceIds before
  // exact-shape validation and never escape the validator contract.
  'selectedEvidenceIds', 'evidenceSourceIds',
]);
const compatibleTopLevelStateKeys = new Set([
  'currentTopic', 'knownEntityKeys', 'knownEntities', 'selectedEntityKeys',
  'collectedInformation', 'fieldUpdates', 'correctedFields', 'language',
  'pendingQuestionRelevant', 'activeToolRequest', 'requestType', 'questionType',
  'requestedFacts', 'constraints', 'contextualReferences', 'contextDependent',
]);

function normalizeDecisionEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const unknown = Object.keys(value).filter((key) => (
    !decisionEnvelopeKeys.has(key) && !compatibleTopLevelStateKeys.has(key)
  ));
  if (unknown.length) return null;
  const suppliedState = value.stateUpdate === undefined ? {} : value.stateUpdate;
  if (!suppliedState || typeof suppliedState !== 'object' || Array.isArray(suppliedState)) {
    return null;
  }
  const stateUpdate = { ...suppliedState };
  for (const key of compatibleTopLevelStateKeys) {
    if (value[key] !== undefined && stateUpdate[key] === undefined) stateUpdate[key] = value[key];
  }
  const normalizedDecision = normalizeDecision(value.decision);
  let compactToolRequest = null;
  if (value.toolName !== undefined && value.toolName !== null) {
    const toolName = text(value.toolName, 160);
    if (!toolName || typeof value.toolArguments !== 'string') return null;
    try {
      const argumentsObject = JSON.parse(value.toolArguments);
      if (!argumentsObject || typeof argumentsObject !== 'object' || Array.isArray(argumentsObject)) {
        return null;
      }
      compactToolRequest = { name: toolName, arguments: argumentsObject };
    } catch {
      return null;
    }
  } else if (value.toolArguments !== undefined && value.toolArguments !== null) return null;
  const compactClarificationReason = value.clarificationReason === undefined
    || value.clarificationReason === null ? null : { reason: value.clarificationReason };
  const compactClarificationQuestion = normalizedDecision === 'clarify'
    && value.pendingQuestion === undefined ? value.answer : undefined;
  return {
    decision: value.decision,
    answer: compactClarificationQuestion === undefined ? (value.answer ?? '') : '',
    responseId: value.responseId ?? null,
    evidenceIds: value.evidenceIds ?? value.selectedEvidenceIds
      ?? value.evidenceSourceIds ?? [],
    stateUpdate,
    pendingQuestion: value.pendingQuestion ?? compactClarificationQuestion ?? null,
    toolRequest: value.toolRequest ?? compactToolRequest,
    clarification: value.clarification ?? compactClarificationReason,
  };
}

function normalizeFieldValue(value, schema, envelope) {
  if (value === undefined || value === null || value === '') return undefined;
  if (schema.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (schema.type === 'number' || schema.type === 'integer') {
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric) || (schema.type === 'integer' && !Number.isInteger(numeric))) return undefined;
    return numeric;
  }
  const normalized = text(value, 500);
  if (!normalized) return undefined;
  if (schema.type === 'select') {
    const requested = identity(normalized);
    const option = (schema.options ?? []).find((candidate) => (
      [candidate?.value, candidate?.label, ...(Array.isArray(candidate?.aliases)
        ? candidate.aliases : [])].map(identity).filter(Boolean).includes(requested)
    ));
    return option?.value;
  }
  if (schema.type === 'catalog_reference') {
    const requested = identity(normalized);
    const requiredType = text(schema.catalogReference?.recordType, 80).toLocaleLowerCase();
    const entity = (envelope.entities ?? []).find((candidate) => {
      const recordType = text(candidate?.recordType ?? candidate?.type, 80).toLocaleLowerCase();
      return (!requiredType || recordType === requiredType)
        && [candidate?.id, candidate?.key, candidate?.name,
          ...(Array.isArray(candidate?.aliases) ? candidate.aliases : [])]
          .map(identity).filter(Boolean).includes(requested);
    });
    return entity ? text(entity.name ?? entity.key ?? entity.id, 500) : undefined;
  }
  if (schema.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return undefined;
  if (schema.type === 'phone' && !/^\+?[\d\s()-]{8,25}$/u.test(normalized)) return undefined;
  return normalized;
}

function normalizeStateUpdate(value, envelope, runtime) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedKeys = new Set([
    'currentTopic', 'knownEntityKeys', 'collectedInformation', 'correctedFields',
    'language', 'pendingQuestionRelevant', 'activeToolRequest',
    'requestType', 'requestedFacts', 'constraints', 'contextualReferences',
    'contextDependent',
    // Accepted only as rolling-deployment aliases and normalized below.
    'knownEntities', 'selectedEntityKeys', 'fieldUpdates', 'questionType',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  const aliasedEntities = Array.isArray(value.knownEntities)
    ? value.knownEntities.map((entry) => entry?.key ?? entry?.name ?? entry?.id).filter(Boolean)
    : [];
  const canonical = {
    ...value,
    knownEntityKeys: value.knownEntityKeys ?? value.selectedEntityKeys ?? aliasedEntities,
    collectedInformation: value.collectedInformation ?? value.fieldUpdates ?? {},
  };
  const entityLookup = new Map((envelope.entities ?? []).flatMap((entity) => (
    [entity.key, entity.name, entity.id, ...(Array.isArray(entity.aliases) ? entity.aliases : [])]
      .filter(Boolean).map((candidate) => [identity(candidate), entity])
  )));
  const requestedEntities = list(canonical.knownEntityKeys, maximumEntities);
  const knownEntities = [];
  const seenEntities = new Set();
  for (const requested of requestedEntities) {
    const entity = entityLookup.get(identity(requested));
    if (!entity) return null;
    if (!seenEntities.has(entity.key)) knownEntities.push(entity);
    seenEntities.add(entity.key);
  }
  let activeToolRequest = null;
  if (canonical.activeToolRequest !== undefined && canonical.activeToolRequest !== null) {
    if (!canonical.activeToolRequest || typeof canonical.activeToolRequest !== 'object'
      || Array.isArray(canonical.activeToolRequest)) return null;
    const name = text(canonical.activeToolRequest.name, 64);
    if (!(runtime.toolSchemas ?? []).some((tool) => tool.name === name)) return null;
    activeToolRequest = Object.freeze({ name, status: 'collecting_information' });
  }
  const requestedInformation = canonical.collectedInformation ?? {};
  if (!requestedInformation || typeof requestedInformation !== 'object'
    || Array.isArray(requestedInformation)) return null;
  const activeTool = text(activeToolRequest?.name ?? runtime.activeToolRequest?.name, 100).toLocaleLowerCase();
  // Caller fields are action state, not ordinary conversational memory. Do
  // not accept personal/configured values before an assigned tool is active.
  const fieldSchemas = new Map((runtime.fieldSchemas ?? []).filter((field) => (
    !field.requiredAction
    || (activeTool && text(field.requiredAction, 100).toLocaleLowerCase() === activeTool)
  )).map((field) => [field.key, field]));
  const collectedInformation = {};
  for (const [key, fieldValue] of Object.entries(requestedInformation)) {
    const schema = fieldSchemas.get(key);
    if (!schema) return null;
    const normalized = normalizeFieldValue(fieldValue, schema, envelope);
    if (normalized === undefined) return null;
    collectedInformation[key] = normalized;
  }
  const correctedFields = list(canonical.correctedFields, 30);
  if (correctedFields.some((key) => !Object.hasOwn(collectedInformation, key))) return null;
  if (canonical.pendingQuestionRelevant !== undefined
    && typeof canonical.pendingQuestionRelevant !== 'boolean') return null;
  if (canonical.contextDependent !== undefined
    && typeof canonical.contextDependent !== 'boolean') return null;
  const resolvedRequestType = canonical.requestType === undefined
    && canonical.questionType === undefined
    ? null : requestType(canonical.requestType ?? canonical.questionType);
  if ((canonical.requestType !== undefined || canonical.questionType !== undefined)
    && !resolvedRequestType) return null;
  const canonicalTopic = knownEntities.length > 0
    ? knownEntities[0].key : (text(canonical.currentTopic, 240) || null);
  return Object.freeze({
    // Once the model selects a published entity, the runtime owns its topic
    // identity. Free-form model labels must never replace canonical memory.
    currentTopic: canonicalTopic,
    knownEntityKeys: Object.freeze(knownEntities.map((entity) => entity.key)),
    knownEntities: Object.freeze(knownEntities.map((entity) => ({ ...entity }))),
    collectedInformation: Object.freeze(collectedInformation),
    correctedFields: Object.freeze(correctedFields),
    language: text(canonical.language, 20) || null,
    pendingQuestionRelevant: canonical.pendingQuestionRelevant ?? true,
    activeToolRequest,
    requestType: canonical.requestType !== undefined || canonical.questionType !== undefined
      ? resolvedRequestType : undefined,
    requestedFacts: canonical.requestedFacts !== undefined
      ? Object.freeze(list(canonical.requestedFacts, 20)) : undefined,
    constraints: canonical.constraints !== undefined
      ? Object.freeze(list(canonical.constraints, 20)) : undefined,
    contextualReferences: canonical.contextualReferences !== undefined
      ? Object.freeze(list(canonical.contextualReferences, 20)) : undefined,
    contextDependent: canonical.contextDependent,
  });
}

function recoverSafeAnswerStateUpdate(value, envelope, runtime) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = {};
  const currentTopic = text(candidate.currentTopic, 240);
  const language = text(candidate.language, 20);
  const resolvedRequestType = requestType(candidate.requestType ?? candidate.questionType);
  if (currentTopic) safe.currentTopic = currentTopic;
  if (language) safe.language = language;
  if (typeof candidate.pendingQuestionRelevant === 'boolean') {
    safe.pendingQuestionRelevant = candidate.pendingQuestionRelevant;
  }
  if (typeof candidate.contextDependent === 'boolean') safe.contextDependent = candidate.contextDependent;
  if (resolvedRequestType) safe.requestType = resolvedRequestType;
  if (Array.isArray(candidate.requestedFacts)) safe.requestedFacts = list(candidate.requestedFacts, 20);
  if (Array.isArray(candidate.constraints)) safe.constraints = list(candidate.constraints, 20);
  if (Array.isArray(candidate.contextualReferences)) {
    safe.contextualReferences = list(candidate.contextualReferences, 20);
  }
  // Entity selection, collected caller values and tool state are deliberately
  // excluded from recovery. They require strict evidence/schema validation.
  return normalizeStateUpdate(safe, envelope, runtime) ?? normalizeStateUpdate({}, envelope, runtime);
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function argumentsMatchSchema(value, schema = {}) {
  if (!matchesType(value, schema.type ?? 'object')) return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  if (schema.additionalProperties === false
    && Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
  return Object.entries(schema.properties ?? {}).every(([key, property]) => (
    !Object.hasOwn(value, key) || !property?.type || matchesType(value[key], property.type)
  ));
}

function normalizeToolRequest(value, decision, runtime) {
  if (decision !== 'action') return value === null ? null : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = text(value.name, 64);
  const tool = (runtime.toolSchemas ?? []).find((candidate) => candidate.name === name);
  const argumentsValue = value.arguments ?? {};
  if (!tool || !argumentsMatchSchema(argumentsValue, tool.inputSchema)) return undefined;
  return Object.freeze({ name, arguments: Object.freeze({ ...argumentsValue }) });
}

function meaningfulTokens(value) {
  return identity(value).split(' ').filter((token) => token.length >= 4 || /\d/u.test(token));
}

function supportRatio(answer, evidence) {
  const answerTokens = meaningfulTokens(answer);
  if (!answerTokens.length) return 1;
  const evidenceTokens = new Set(meaningfulTokens(evidence));
  return answerTokens.filter((token) => evidenceTokens.has(token)).length / answerTokens.length;
}

function internalSpeech(value) {
  return /(?:grounded[_ ]response|evidenceids|stateupdate|toolrequest|runtime context|system prompt)/iu.test(value)
    || /^\s*(?:instruction|workflow|debug|json)\s*:/iu.test(value);
}

function splitCallerQuestion(value, configuredQuestion, decision) {
  const original = text(value, maximumAnswerCharacters);
  const pendingQuestion = configuredQuestion === null ? null : text(configuredQuestion, 500);
  // Question punctuation is valid caller-facing speech. Previously, any
  // answer ending in "?" was treated as one large pending question, which
  // erased the factual answer and produced answer_required. The structured
  // pendingQuestion field is the only reliable boundary. Remove it from the
  // answer only when it is an exact trailing duplicate.
  if (pendingQuestion && original.toLocaleLowerCase().endsWith(pendingQuestion.toLocaleLowerCase())) {
    const answer = text(original.slice(0, original.length - pendingQuestion.length), maximumAnswerCharacters);
    return Object.freeze({ answer, pendingQuestion });
  }
  // Clarifications are spoken from pendingQuestion; do not repeat question-
  // only text placed in answer by a provider.
  if (decision === 'clarify' && pendingQuestion && /^[^.!]*[?？](?:\s*[^.!]*[?？])*$/u.test(original)) {
    return Object.freeze({ answer: '', pendingQuestion });
  }
  return Object.freeze({ answer: original, pendingQuestion });
}

export function groundedDecisionContract(envelope, runtime = {}) {
  const fields = (runtime.fieldSchemas ?? []).map((field) => ({
    key: field.key, label: field.label, type: field.type,
    required: field.required !== false, question: field.question,
    ...(field.requiredAction ? { requiredAction: field.requiredAction } : {}),
  }));
  const tools = (runtime.toolSchemas ?? []).map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
  }));
  return Object.freeze({
    format: 'json_object',
    exactFields: [
      'decision', 'answer', 'responseId', 'evidenceIds', 'toolName',
      'toolArguments', 'clarificationReason',
    ],
    fieldOrder: ['decision', 'answer', 'evidenceIds', 'responseId', 'toolName',
      'toolArguments', 'clarificationReason'],
    rules: [
      'Answer the latest caller question first.',
      'Return RESPONSE for grounded caller-facing speech, TOOL for one authorized action, or CLARIFY when evidence is genuinely weak or ambiguous.',
      'For CLARIFY, put one targeted caller-facing question in answer and set clarificationReason.',
      'Use TOOL only for one configured tool and never claim success before its verified result.',
      'Never request or collect a configured information field unless the caller explicitly requested the assigned action and the selected Workflow evidence authorizes that tool.',
      'Use only evidenceIds listed below for factual speech.',
      'When naming a resolved Catalog entity or category, use its canonical name from authoritativeData; caller aliases are for understanding, not factual display names.',
      'Do not recommend or claim that an item is suitable for symptoms, conditions, or personal needs unless the selected evidence explicitly authorizes that recommendation.',
      'A relationship-backed screening suggestion must be presented as a published relationship, not a diagnosis or guarantee, and must say that a qualified professional must confirm personal medical suitability.',
      'When a safety-sensitive request requires authorized human support, use only the configured tool authorized by selected Workflow evidence; otherwise give a grounded limitation without inventing an action.',
      'Set responseId only when selecting one exact caller-facing published response; otherwise use null.',
      'When multiple exact caller-facing responses are available, select by the meaning of the complete latest utterance together with the immediately pending question and each source situation/context. A short contextual answer resolves the pending question; do not reinterpret it as a presence check unless that is its complete meaning.',
      'For RESPONSE, toolName, toolArguments and clarificationReason must be null.',
      'For TOOL, set toolName and toolArguments as a JSON-object string; clarificationReason must be null.',
      'For CLARIFY, set clarificationReason; toolName and toolArguments must be null.',
      'Use missing_entity when a requested fact has no explicit or remembered canonical entity. Use missing_fact when an entity is known but the caller has not identified the fact needed.',
      'Use authoritative_ambiguity only when supplied ambiguityCandidates contain multiple genuinely close authoritative records; pendingQuestion must name the closest canonical candidates.',
      'Interpret the complete current question with only the supplied relevant call memory and published evidence.',
      'Interpret the requested fact, explicit entities, comparison entities, contextual references and action intent from the supplied input; do not echo internal interpretation state.',
      'If the latest question omits an entity but relevant call memory contains an active canonical entity or category, interpret contextual requested facts against that remembered record and select its permitted source.',
      'If a requested fact requires an entity and neither the latest question nor relevant call memory and evidence identify one, return a targeted CLARIFY question; never select an arbitrary evidence record.',
      'The latest explicit entity or category replaces a stale remembered topic. Use remembered entities only when the current question genuinely depends on context.',
      'Return CLARIFY only for genuine ambiguity between supported candidates or genuinely missing/conflicting evidence; never clarify merely because caller wording differs from a published phrase.',
      'For medium-confidence entity resolution, ask one candidate-specific confirmation using the canonical published name. For low confidence, ask which published category or option the caller means; do not reuse a generic unclear-message sentence.',
      'Use pendingClarification attemptCount, previousQuestions, candidateRecordIds and missingFactType as recovery context. Never repeat an earlier clarification verbatim; narrow the next question using remaining published candidates or the missing fact.',
      'Do not invent a support channel or support promise after unresolved attempts. Runtime may use only an explicitly tenant-configured clarification recovery response.',
      'For comparisons, cover every explicitly requested hydrated entity. Describe each difference with positively supported fields from its record. Do not infer that an item lacks something unless its selected evidence explicitly states that negative fact.',
      'Do not depend on exact caller wording or application-defined business vocabulary.',
    ],
    schema: {
      decision: 'RESPONSE | TOOL | CLARIFY',
      answer: 'natural caller-facing speech with no question; empty only for TOOL',
      responseId: 'one exact caller-facing published response source ID or null',
      evidenceIds: ['approved source IDs'],
      toolName: 'configured tool name or null',
      toolArguments: 'JSON-object string for TOOL or null',
      clarificationReason: 'clarification reason or null',
    },
    allowedEvidenceIds: (envelope.sources ?? []).map((source) => source.id),
    exactCallerResponseSourceIds: envelope.exactCallerResponses ?? [],
    allowedEntityKeys: (envelope.entities ?? []).map((entity) => entity.key),
    configuredInformationFields: fields,
    configuredToolSchemas: tools,
  });
}

export function groundedDecisionJsonSchema(envelope, runtime = {}) {
  const evidenceIds = (envelope.sources ?? []).map((source) => source.id).filter(Boolean);
  const tools = runtime.toolSchemas ?? [];
  const toolNames = tools.map((tool) => tool.name).filter(Boolean);
  const exactResponseIds = (envelope.exactCallerResponses ?? []).filter(Boolean);
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'decision', 'answer', 'responseId', 'evidenceIds', 'toolName',
      'toolArguments', 'clarificationReason',
    ],
    properties: {
      decision: { type: 'string', enum: [...externalDecisions] },
      answer: { type: 'string' },
      responseId: exactResponseIds.length ? {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: exactResponseIds },
        ],
      } : { type: 'null' },
      evidenceIds: {
        type: 'array',
        items: { type: 'string', ...(evidenceIds.length ? { enum: evidenceIds } : {}) },
      },
      toolName: toolNames.length ? {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: toolNames },
        ],
      } : { type: 'null' },
      toolArguments: toolNames.length ? {
        anyOf: [
          { type: 'null' },
          { type: 'string' },
        ],
      } : { type: 'null' },
      clarificationReason: {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: [...clarificationReasons] },
        ],
      },
    },
  });
}

export function validateGroundedLlmDecision(raw, envelope, runtime = {}) {
  const parsedObject = parseObject(raw);
  if (!parsedObject) return Object.freeze({ valid: false, reason: 'invalid_json' });
  const parsed = normalizeDecisionEnvelope(parsedObject);
  if (!parsed || !exactShape(parsed)) {
    return Object.freeze({ valid: false, reason: 'invalid_response_shape' });
  }
  const decision = normalizeDecision(parsed.decision);
  if (!decisions.has(decision)) return Object.freeze({ valid: false, reason: 'invalid_decision' });
  const parsedClarification = parsed.clarification === null ? null : (() => {
    if (!parsed.clarification || typeof parsed.clarification !== 'object'
      || Array.isArray(parsed.clarification)
      || Object.keys(parsed.clarification).sort().join('|') !== 'reason') return undefined;
    const reason = text(parsed.clarification.reason, 64).toLocaleLowerCase();
    return clarificationReasons.has(reason) ? Object.freeze({ reason }) : undefined;
  })();
  // Clarification metadata never authorizes facts, evidence or actions. Treat
  // it as decision-derived metadata so a provider leaving a stale object on an
  // answer cannot invalidate otherwise valid grounded speech. For an actual
  // clarify decision, infer the narrowest safe reason from the bounded input;
  // the required question is still validated below.
  const clarification = decision === 'clarify'
    ? (parsedClarification ?? Object.freeze({ reason: inferredClarificationReason(runtime) }))
    : null;
  const exactResponseCandidate = (envelope.exactCallerResponses ?? []).length > 0;
  const separated = splitCallerQuestion(parsed.answer, parsed.pendingQuestion, decision);
  // Exact published messages may intentionally end with a caller-facing
  // question. Preserve that punctuation/content instead of treating it as a
  // runtime pending question and altering the approved response.
  const candidateAnswer = exactResponseCandidate ? text(parsed.answer, maximumAnswerCharacters) : separated.answer;
  const candidatePendingQuestion = exactResponseCandidate
    ? (parsed.pendingQuestion === null ? null : text(parsed.pendingQuestion, 500))
    : separated.pendingQuestion;
  if (parsed.pendingQuestion !== null && !candidatePendingQuestion) {
    return Object.freeze({ valid: false, reason: 'invalid_pending_question' });
  }
  if (decision === 'answer' && envelope.incompleteEvidenceMetadata === true
    && envelope.found !== true) {
    return Object.freeze({ valid: false, reason: 'incomplete_evidence_metadata' });
  }
  const allowedSources = new Map((envelope.sources ?? []).flatMap((source) => (
    [source.id, source.publishedEvidenceId, source.recordId]
      .filter(Boolean).map((candidate) => [identity(candidate), source])
  )));
  const requiredEvidenceIds = decision === 'answer' && parsed.responseId === null
    ? list(runtime.requiredEvidenceIds, maximumSources) : [];
  // CLARIFY is a fact-free question. Providers sometimes retain a stale
  // source ID while correctly choosing CLARIFY; discard that residue instead
  // of converting a useful targeted question into an operational fallback.
  const evidenceIds = decision === 'clarify' ? [] : list([
    ...requiredEvidenceIds,
    ...(Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds : []),
  ], maximumSources);
  const citedSources = [];
  const seenSources = new Set();
  for (const requested of evidenceIds) {
    const source = allowedSources.get(identity(requested));
    if (!source) return Object.freeze({ valid: false, reason: 'unpublished_evidence_selected' });
    if (!seenSources.has(source.id)) citedSources.push(source);
    seenSources.add(source.id);
  }
  const responseId = decision === 'clarify' || parsed.responseId === null
    ? null : text(parsed.responseId, 160);
  const exactResponseSource = responseId ? allowedSources.get(identity(responseId)) : null;
  if (responseId && (!exactResponseSource || exactResponseSource.exactCallerResponse !== true)) {
    return Object.freeze({ valid: false, reason: 'invalid_response_id' });
  }
  if (exactResponseSource && !citedSources.some((source) => source.id === exactResponseSource.id)) {
    // responseId itself is an enumerated evidence selection. Canonicalize it
    // into evidenceIds so exact published speech cannot fail only because a
    // provider omitted the same ID from the duplicate evidenceIds property.
    citedSources.push(exactResponseSource);
    seenSources.add(exactResponseSource.id);
  }
  if (responseId && decision !== 'answer') {
    return Object.freeze({ valid: false, reason: 'invalid_response_id' });
  }
  // responseId is a selection, not model-authored speech. The authoritative
  // published RESPONSE always replaces any generated wording. Scope is then
  // checked by applyUnifiedGroundedTurn before this answer can reach TTS.
  const answer = exactResponseSource
    ? text(exactResponseSource.content, maximumAnswerCharacters)
    : candidateAnswer;
  const pendingQuestion = exactResponseSource ? null : candidatePendingQuestion;
  if (decision === 'answer' && !answer) return Object.freeze({ valid: false, reason: 'answer_required' });
  if (internalSpeech(answer)) return Object.freeze({ valid: false, reason: 'internal_text' });
  if (decision === 'clarify' && !pendingQuestion) {
    return Object.freeze({ valid: false, reason: 'clarification_question_required' });
  }
  if (decision === 'clarify' && clarification.reason === 'authoritative_ambiguity') {
    const candidates = (runtime.clarificationContext?.ambiguityCandidates ?? [])
      .map((candidate) => text(
        candidate.canonicalName ?? candidate.name ?? candidate.displayName, 200,
      ))
      .filter(Boolean);
    if (candidates.length < 2) {
      return Object.freeze({ valid: false, reason: 'invalid_clarification_reason' });
    }
    const normalizedQuestion = identity(pendingQuestion);
    if (!candidates.some((candidate) => normalizedQuestion.includes(identity(candidate)))) {
      return Object.freeze({ valid: false, reason: 'candidate_specific_clarification_required' });
    }
  }
  if (decision === 'answer' && envelope.found && citedSources.length === 0) {
    return Object.freeze({ valid: false, reason: 'selected_evidence_ids_required' });
  }
  if (decision === 'answer' && !envelope.found) {
    return Object.freeze({ valid: false, reason: 'verified_evidence_missing' });
  }
  // A published caller-facing message is an exact response contract. Once
  // the latest-turn retriever selects it, the model may cite it but cannot
  // paraphrase it, replace it with a partial list, or turn it into a question.
  const exactSources = citedSources.filter((source) => source.exactCallerResponse === true);
  const nonExactSources = citedSources.filter((source) => source.exactCallerResponse !== true);
  const requiredExactSourceIds = new Set(envelope.exactCallerResponses ?? []);
  const requestedResponseType = text(parsed.stateUpdate?.requestType, 80)
    .toLocaleLowerCase().replace(/[\s./-]+/gu, '_');
  // Exact messages present in the evidence set are alternatives, not a global
  // mandate. Require responseId when the model cites one or identifies an
  // overview/options request; a specific item/details answer may legitimately
  // cite only Catalog evidence even while unrelated messages remain available.
  const exactResponseRequired = Boolean(responseId)
    || exactResponseRequestTypes.has(requestedResponseType)
    // When exact speech is the only cited support, omitting responseId would
    // permit an unsafe paraphrase. If authoritative non-exact evidence also
    // supports a non-overview request, an incidental message citation must not
    // force that unrelated message to replace the requested factual answer.
    || (exactSources.length > 0 && nonExactSources.length === 0);
  if (decision === 'answer' && exactResponseRequired && requiredExactSourceIds.size > 0
    && !exactSources.some((source) => requiredExactSourceIds.has(source.id))) {
    return Object.freeze({ valid: false, reason: 'exact_published_response_required' });
  }
  if (decision === 'answer' && exactResponseRequired && requiredExactSourceIds.size > 0
    && !responseId) {
    return Object.freeze({ valid: false, reason: 'response_id_required' });
  }
  const evidenceText = citedSources.map((source) => {
    let structured = '';
    try {
      structured = source.authoritativeData && typeof source.authoritativeData === 'object'
        ? JSON.stringify(source.authoritativeData)
        : '';
    } catch {
      structured = '';
    }
    return `${source.content ?? ''} ${structured}`;
  }).join(' ');
  const evidenceNumbers = numbers(evidenceText);
  const unsupportedNumbers = answer
    ? [...numbers(answer)].filter((number) => !evidenceNumbers.has(number)) : [];
  if (unsupportedNumbers.length) {
    return Object.freeze({
      valid: false,
      reason: 'unsupported_numeric_fact',
      numbers: Object.freeze(unsupportedNumbers),
      rejectedAnswer: answer,
      evidenceIds: Object.freeze(citedSources.map((source) => source.id)),
    });
  }
  // Surface-token overlap is not a reliable evidence test for Tamil,
  // Tanglish, translations, or natural spoken paraphrases. The hydrated
  // claim validator still enforces selected evidence, numbers, entities,
  // safety policies and verified tool results before speech.
  let stateUpdate = normalizeStateUpdate(parsed.stateUpdate, envelope, runtime);
  if (!stateUpdate) {
    // Optional memory metadata must never discard grounded speech or a valid
    // clarification question. Recover only harmless generic context and
    // discard unverified entities, caller fields and tool state. Actions stay
    // strict because their state can authorize field collection or tools.
    if (decision === 'action') return Object.freeze({ valid: false, reason: 'invalid_state_update' });
    stateUpdate = recoverSafeAnswerStateUpdate(parsed.stateUpdate, envelope, runtime);
  }
  const toolRequest = normalizeToolRequest(parsed.toolRequest, decision, runtime);
  if (toolRequest === undefined) return Object.freeze({ valid: false, reason: 'invalid_tool_request' });
  return Object.freeze({
    valid: true, decision, answer, responseId,
    evidenceIds: Object.freeze(citedSources.map((source) => source.id)),
    stateUpdate, pendingQuestion, toolRequest, clarification,
    // Internal compatibility fields consumed by generic memory and the local
    // sentence evidence gate. They are never requested from or spoken by LLM.
    spokenAnswer: answer,
    evidenceSourceIds: Object.freeze(citedSources.map((source) => source.id)),
    selectedEntityKeys: stateUpdate.knownEntityKeys,
    selectedEntities: stateUpdate.knownEntities,
    currentTopic: stateUpdate.currentTopic,
    pendingQuestionRelevant: stateUpdate.pendingQuestionRelevant,
    fieldUpdates: stateUpdate.collectedInformation,
    correctedFields: stateUpdate.correctedFields,
    language: stateUpdate.language,
    activeToolRequest: stateUpdate.activeToolRequest,
    requestType: stateUpdate.requestType,
    requestedFacts: stateUpdate.requestedFacts,
    constraints: stateUpdate.constraints,
    contextualReferences: stateUpdate.contextualReferences,
    contextDependent: stateUpdate.contextDependent,
    flowAction: decision === 'clarify' ? 'clarify' : 'continue',
  });
}

function jsonArrayField(raw, name) {
  const match = new RegExp(`"${name}"\\s*:\\s*(\\[[^\\]]*\\])`, 'iu').exec(raw);
  if (!match) return null;
  try { const parsed = JSON.parse(match[1]); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

function partialJsonStringField(raw, name) {
  const marker = new RegExp(`"${name}"\\s*:\\s*"`, 'iu').exec(raw);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  let escaped = false;
  let end = raw.length;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { end = index; break; }
  }
  let encoded = raw.slice(start, end);
  while (encoded.endsWith('\\') && !encoded.endsWith('\\\\')) encoded = encoded.slice(0, -1);
  try { return JSON.parse(`"${encoded}"`); } catch { return null; }
}

export function createGroundedDecisionStreamDecoder(envelope) {
  let raw = '';
  let decision = null;
  const allowedSources = new Set((envelope.sources ?? []).map((source) => source.id));
  return Object.freeze({
    push(delta) {
      raw += String(delta ?? '');
      const sourceIds = jsonArrayField(raw, 'evidenceIds');
      const decisionValue = partialJsonStringField(raw, 'decision');
      if (sourceIds && decisions.has(decisionValue)
        && sourceIds.every((sourceId) => allowedSources.has(sourceId))) {
        decision = Object.freeze({
          decision: decisionValue,
          evidenceIds: Object.freeze([...sourceIds]),
          evidenceSourceIds: Object.freeze([...sourceIds]),
          selectedEntityKeys: Object.freeze([]),
        });
      }
      // Keep structural observation available, but never release partial
      // answer text. The orchestrator emits only the final answer returned
      // after complete decision validation.
      return Object.freeze({ delta: '', decision });
    },
    decision: () => decision,
    releasedText: () => '',
  });
}

export { decisions as groundedDecisionTypes };
