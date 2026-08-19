const maximumAnswerCharacters = 4_000;
const maximumSources = 10;
const maximumEntities = 20;
const decisions = new Set(['answer', 'clarify', 'action']);
const repairableDecisionReasons = new Set(['invalid_response_shape', 'answer_required']);

export function isRepairableGroundedDecisionReason(reason) {
  return repairableDecisionReasons.has(String(reason ?? '').trim());
}
const clarificationReasons = new Set([
  'ambiguous_request', 'missing_evidence', 'conflicting_evidence',
  'missing_required_information',
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

function normalizeFieldValue(value, schema) {
  if (value === undefined || value === null || value === '') return undefined;
  if (schema.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (schema.type === 'number' || schema.type === 'integer') {
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric) || (schema.type === 'integer' && !Number.isInteger(numeric))) return undefined;
    return numeric;
  }
  const normalized = text(value, 500);
  if (!normalized) return undefined;
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
    [entity.key, entity.name, entity.id].filter(Boolean).map((candidate) => [identity(candidate), entity])
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
    const normalized = normalizeFieldValue(fieldValue, schema);
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
  return Object.freeze({
    currentTopic: text(canonical.currentTopic, 240) || null,
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

function numbers(value) {
  return new Set((text(value, maximumAnswerCharacters).match(/\p{Sc}?\s*\d[\d,.:%/-]*/gu) ?? [])
    .map((entry) => entry.replace(/[^\d]/gu, '')).filter(Boolean));
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
      'decision', 'answer', 'responseId', 'evidenceIds', 'stateUpdate',
      'pendingQuestion', 'toolRequest', 'clarification',
    ],
    fieldOrder: [
      'evidenceIds', 'responseId', 'stateUpdate', 'decision', 'answer',
      'pendingQuestion', 'clarification', 'toolRequest',
    ],
    rules: [
      'Answer the latest caller question first.',
      'Use clarify only when recent context and approved evidence cannot resolve the meaning.',
      'Do not put question text in answer. Put at most one proposed clarification in pendingQuestion.',
      'Use action only for one configured tool and never claim success before its verified result.',
      'Never request or collect a configured information field unless the caller explicitly requested the assigned action and the selected Workflow evidence authorizes that tool.',
      'Use only evidenceIds listed below for factual speech.',
      'Set responseId only when selecting one exact caller-facing published response; otherwise use null.',
      'When multiple exact caller-facing responses are available, select by the meaning of the complete latest utterance together with the immediately pending question and each source situation/context. A short contextual answer resolves the pending question; do not reinterpret it as a presence check unless that is its complete meaning.',
      'For clarify, set clarification.reason and pendingQuestion. For answer or action, clarification must be null.',
      'For an ordinary answer with no memory change, return stateUpdate as an empty object.',
      'Resolve meaning generically in stateUpdate when useful: requestType, currentTopic, knownEntityKeys, requestedFacts, constraints, contextualReferences and contextDependent.',
      'Do not depend on exact caller wording or application-defined business vocabulary.',
    ],
    schema: {
      decision: 'answer | clarify | action',
      answer: 'natural caller-facing speech with no question; empty only for action',
      responseId: 'one exact caller-facing published response source ID or null',
      evidenceIds: ['approved source IDs'],
      stateUpdate: {
        currentTopic: 'optional topic', knownEntityKeys: ['approved entity keys'],
        collectedInformation: Object.fromEntries(fields.map((field) => [field.key, `optional ${field.type}`])),
        correctedFields: ['corrected collectedInformation keys'], language: 'optional language code',
        pendingQuestionRelevant: 'optional boolean',
        activeToolRequest: 'optional null or {name} for one configured tool whose fields are being collected',
        requestType: 'optional generic snake_case request type',
        requestedFacts: ['optional facts requested by the caller'],
        constraints: ['optional caller constraints'],
        contextualReferences: ['optional references such as this, that, it or the previous item'],
        contextDependent: 'optional boolean; true only when recent context is required',
      },
      pendingQuestion: 'one proposed short question string or null; runtime speaks only configured text',
      toolRequest: 'null or {name, arguments}',
      clarification: 'null or {reason: ambiguous_request | missing_evidence | conflicting_evidence | missing_required_information}',
    },
    allowedEvidenceIds: (envelope.sources ?? []).map((source) => source.id),
    exactCallerResponseSourceIds: envelope.exactCallerResponses ?? [],
    allowedEntityKeys: (envelope.entities ?? []).map((entity) => entity.key),
    configuredInformationFields: fields,
    configuredToolSchemas: tools,
  });
}

function jsonSchemaType(type) {
  if (type === 'integer' || type === 'number' || type === 'boolean') return type;
  if (type === 'array' || type === 'object') return type;
  return 'string';
}

export function groundedDecisionJsonSchema(envelope, runtime = {}) {
  const evidenceIds = (envelope.sources ?? []).map((source) => source.id).filter(Boolean);
  const entityKeys = (envelope.entities ?? []).map((entity) => entity.key).filter(Boolean);
  const fields = runtime.fieldSchemas ?? [];
  const tools = runtime.toolSchemas ?? [];
  const collectedProperties = Object.fromEntries(fields.map((field) => [field.key, {
    type: [jsonSchemaType(field.type), 'null'],
  }]));
  const toolNames = tools.map((tool) => tool.name).filter(Boolean);
  const exactResponseIds = (envelope.exactCallerResponses ?? []).filter(Boolean);
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'decision', 'answer', 'responseId', 'evidenceIds', 'stateUpdate',
      'pendingQuestion', 'toolRequest', 'clarification',
    ],
    properties: {
      decision: { type: 'string', enum: [...decisions] },
      answer: { type: 'string', maxLength: maximumAnswerCharacters },
      responseId: exactResponseIds.length ? {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: exactResponseIds },
        ],
      } : { type: 'null' },
      evidenceIds: {
        type: 'array', uniqueItems: true, maxItems: maximumSources,
        items: { type: 'string', ...(evidenceIds.length ? { enum: evidenceIds } : {}) },
      },
      stateUpdate: {
        type: 'object', additionalProperties: false,
        properties: {
          currentTopic: { type: ['string', 'null'] },
          knownEntityKeys: {
            type: 'array', uniqueItems: true, maxItems: maximumEntities,
            items: { type: 'string', ...(entityKeys.length ? { enum: entityKeys } : {}) },
          },
          collectedInformation: {
            type: 'object', additionalProperties: false, properties: collectedProperties,
          },
          correctedFields: {
            type: 'array', uniqueItems: true,
            items: { type: 'string', enum: fields.map((field) => field.key) },
          },
          language: { type: ['string', 'null'] },
          pendingQuestionRelevant: { type: 'boolean' },
          requestType: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9_]{0,63}$' },
          requestedFacts: {
            type: 'array', uniqueItems: true, maxItems: 20,
            items: { type: 'string', maxLength: 160 },
          },
          constraints: {
            type: 'array', uniqueItems: true, maxItems: 20,
            items: { type: 'string', maxLength: 160 },
          },
          contextualReferences: {
            type: 'array', uniqueItems: true, maxItems: 20,
            items: { type: 'string', maxLength: 160 },
          },
          contextDependent: { type: 'boolean' },
          activeToolRequest: toolNames.length ? {
            anyOf: [
              { type: 'null' },
              {
                type: 'object', additionalProperties: false, required: ['name'],
                properties: { name: { type: 'string', enum: toolNames } },
              },
            ],
          } : { type: 'null' },
        },
      },
      pendingQuestion: { type: ['string', 'null'], maxLength: 500 },
      clarification: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object', additionalProperties: false, required: ['reason'],
            properties: { reason: { type: 'string', enum: [...clarificationReasons] } },
          },
        ],
      },
      toolRequest: toolNames.length ? {
        anyOf: [
          { type: 'null' },
          {
            type: 'object', additionalProperties: false, required: ['name', 'arguments'],
            properties: {
              name: { type: 'string', enum: toolNames },
              arguments: { type: 'object' },
            },
          },
        ],
      } : { type: 'null' },
    },
  });
}

export function validateGroundedLlmDecision(raw, envelope, runtime = {}) {
  const parsed = parseObject(raw);
  if (!parsed) return Object.freeze({ valid: false, reason: 'invalid_json' });
  if (!exactShape(parsed)) return Object.freeze({ valid: false, reason: 'invalid_response_shape' });
  const decision = text(parsed.decision, 20).toLocaleLowerCase();
  if (!decisions.has(decision)) return Object.freeze({ valid: false, reason: 'invalid_decision' });
  const clarification = parsed.clarification === null ? null : (() => {
    if (!parsed.clarification || typeof parsed.clarification !== 'object'
      || Array.isArray(parsed.clarification)
      || Object.keys(parsed.clarification).sort().join('|') !== 'reason') return undefined;
    const reason = text(parsed.clarification.reason, 64).toLocaleLowerCase();
    return clarificationReasons.has(reason) ? Object.freeze({ reason }) : undefined;
  })();
  if (clarification === undefined
    || (decision === 'clarify' && clarification === null)
    || (decision !== 'clarify' && clarification !== null)) {
    return Object.freeze({ valid: false, reason: 'invalid_clarification' });
  }
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
  const allowedSources = new Map((envelope.sources ?? []).flatMap((source) => (
    [source.id, source.recordId].filter(Boolean).map((candidate) => [identity(candidate), source])
  )));
  const evidenceIds = list(parsed.evidenceIds, maximumSources);
  const citedSources = [];
  const seenSources = new Set();
  for (const requested of evidenceIds) {
    const source = allowedSources.get(identity(requested));
    if (!source) return Object.freeze({ valid: false, reason: 'unpublished_evidence_selected' });
    if (!seenSources.has(source.id)) citedSources.push(source);
    seenSources.add(source.id);
  }
  const responseId = parsed.responseId === null ? null : text(parsed.responseId, 160);
  const exactResponseSource = responseId ? allowedSources.get(identity(responseId)) : null;
  if (responseId && (!exactResponseSource || exactResponseSource.exactCallerResponse !== true)) {
    return Object.freeze({ valid: false, reason: 'invalid_response_id' });
  }
  if (exactResponseSource && !citedSources.some((source) => source.id === exactResponseSource.id)) {
    return Object.freeze({ valid: false, reason: 'response_evidence_required' });
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
  if (decision === 'answer' && envelope.found && citedSources.length === 0) {
    return Object.freeze({ valid: false, reason: 'evidence_required' });
  }
  if (decision === 'answer' && !envelope.found) {
    return Object.freeze({ valid: false, reason: 'verified_evidence_missing' });
  }
  // A published caller-facing message is an exact response contract. Once
  // the latest-turn retriever selects it, the model may cite it but cannot
  // paraphrase it, replace it with a partial list, or turn it into a question.
  const exactSources = citedSources.filter((source) => source.exactCallerResponse === true);
  const requiredExactSourceIds = new Set(envelope.exactCallerResponses ?? []);
  const requestedResponseType = text(parsed.stateUpdate?.requestType, 80)
    .toLocaleLowerCase().replace(/[\s./-]+/gu, '_');
  // Exact messages present in the evidence set are alternatives, not a global
  // mandate. Require responseId when the model cites one or identifies an
  // overview/options request; a specific item/details answer may legitimately
  // cite only Catalog evidence even while unrelated messages remain available.
  const exactResponseRequired = exactSources.length > 0
    || exactResponseRequestTypes.has(requestedResponseType);
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
  if (answer && [...numbers(answer)].some((number) => !evidenceNumbers.has(number))) {
    return Object.freeze({ valid: false, reason: 'unsupported_numeric_fact' });
  }
  // Surface-token overlap is not a reliable evidence test for Tamil,
  // Tanglish, translations, or natural spoken paraphrases. The hydrated
  // claim validator still enforces selected evidence, numbers, entities,
  // safety policies and verified tool results before speech.
  let stateUpdate = normalizeStateUpdate(parsed.stateUpdate, envelope, runtime);
  if (!stateUpdate) {
    // Optional memory metadata must never discard a grounded ordinary answer.
    // Recover only harmless generic context and discard unverified entities,
    // caller fields and tool state. Action and clarification decisions remain
    // strict because their state controls tools or the next interaction.
    if (decision !== 'answer') return Object.freeze({ valid: false, reason: 'invalid_state_update' });
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
