import { toolArgumentsMatchSchema } from '../tools/tool-security.js';

const maximumQuestionCharacters = 500;

function text(value, maximum = maximumQuestionCharacters) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return text(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function toolIdentity(value) {
  return text(value, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pending(value) {
  if (!value) return null;
  const source = typeof value === 'object' ? value : { text: value };
  const question = text(source.text ?? source.question ?? source.key);
  if (!question) return null;
  return Object.freeze({
    key: text(source.key, 120) || null,
    question,
    kind: text(source.kind, 40) || 'conversation',
    source: 'redis_pending_question',
  });
}

function toolIdentifiers(tool = {}) {
  const configuration = object(tool.configuration);
  return new Set([
    tool.id, tool.name, configuration.identifier, configuration.toolIdentifier,
    configuration.actionKey, configuration.key, ...(tool.identifiers ?? []),
  ].map(toolIdentity).filter(Boolean));
}

function workflowIdentifier(evidence = {}) {
  const data = object(evidence.authoritativeData);
  const config = object(data.actionConfig);
  return toolIdentity(config.toolIdentifier ?? config.actionKey);
}

function authorizedTool(activeRequest, tools, actionEvidence) {
  const activeIdentity = toolIdentity(activeRequest?.name);
  const assigned = (tools ?? []).find((tool) => toolIdentifiers(tool).has(activeIdentity));
  if (!assigned) return null;
  const identifiers = toolIdentifiers(assigned);
  const authorization = (actionEvidence ?? []).find((evidence) => (
    evidence.activationAllowed === true
    &&
    String(evidence.authoritativeData?.actionType ?? '').toLocaleLowerCase() === 'configured_tool'
    && identifiers.has(workflowIdentifier(evidence))
  ));
  const storedAuthorization = text(activeRequest?.authorizationRecordId, 120);
  if (!authorization && !storedAuthorization) return null;
  return Object.freeze({
    tool: assigned,
    authorizationRecordId: text(authorization?.recordId, 120) || storedAuthorization,
  });
}

function fieldBelongsToTool(field, tool) {
  const identifiers = toolIdentifiers(tool);
  if (field.requiredAction) return identifiers.has(toolIdentity(field.requiredAction));
  const required = tool.inputSchema?.required ?? tool.configuration?.inputSchema?.required
    ?? tool.configuration?.input_schema?.required ?? [];
  return Array.isArray(required) && required.includes(field.key);
}

function completedField(field, value, inputSchema) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const property = object(inputSchema.properties)[field.key];
  if (property && !toolArgumentsMatchSchema(value, property)) return false;
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(value))) return false;
  if (field.type === 'phone' && !/^\+?[\d\s()-]{8,25}$/u.test(String(value))) return false;
  if (field.type === 'select') {
    const accepted = (field.options ?? []).flatMap((option) => (
      [option?.value, option?.label, ...(Array.isArray(option?.aliases) ? option.aliases : [])]
    )).map(identity).filter(Boolean);
    if (accepted.length && !accepted.includes(identity(value))) return false;
  }
  return true;
}

function confirmationForTool({
  activeRequest, fieldSchemas, collectedInformation, tools, actionEvidence, configuration,
}) {
  if (!activeRequest) return null;
  const authorization = authorizedTool(activeRequest, tools, actionEvidence);
  if (!authorization) return null;
  const inputSchema = object(authorization.tool.inputSchema
    ?? authorization.tool.configuration?.inputSchema
    ?? authorization.tool.configuration?.input_schema);
  const schemaConfirmation = inputSchema['x-requires-confirmation'] === true;
  const configuredConfirmation = configuration?.enabled === true
    && toolIdentifiers(authorization.tool).has(toolIdentity(configuration.intent));
  if (!schemaConfirmation && !configuredConfirmation) return null;
  const collected = object(collectedInformation);
  const required = configuredConfirmation
    ? (configuration.requiredFields ?? [])
    : (Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const fields = new Map((fieldSchemas ?? []).map((field) => [field.key, field]));
  if (!required.length || required.some((key) => (
    !completedField(fields.get(key) ?? { key }, collected[key], inputSchema)
  ))) return null;
  const details = required.map((key) => {
    const label = text(fields.get(key)?.label ?? key.replace(/_/gu, ' '), 120);
    return `${label}: ${text(collected[key], 500)}`;
  });
  const confirmationMessage = configuredConfirmation
    ? configuration.confirmationMessage
    : (inputSchema['x-confirmation-message']
      ?? 'Would you like me to continue with this action?');
  const rendered = text(confirmationMessage, 2_000).replace(
    /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/giu,
    (match, key) => text(collected[String(key).toLocaleLowerCase()], 500) || match,
  );
  const question = text(`${details.join(', ')}. ${rendered}`, 2_000);
  if (!question) return null;
  return Object.freeze({
    key: `confirm_${toolIdentity(authorization.tool.name)}`,
    question, kind: 'confirmation', source: 'ui_action_confirmation',
    activeToolRequest: Object.freeze({
      ...activeRequest,
      name: authorization.tool.name,
      status: 'awaiting_confirmation',
      authorizationRecordId: authorization.authorizationRecordId,
    }),
  });
}

function nextToolField({ activeRequest, fieldSchemas, collectedInformation, tools, actionEvidence }) {
  const authorization = authorizedTool(activeRequest, tools, actionEvidence);
  if (!authorization) return null;
  const collected = object(collectedInformation);
  const inputSchema = object(authorization.tool.inputSchema
    ?? authorization.tool.configuration?.inputSchema
    ?? authorization.tool.configuration?.input_schema);
  const requiredOrder = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const positions = new Map(requiredOrder.map((key, index) => [key, index]));
  const candidates = [...(fieldSchemas ?? [])].sort((left, right) => (
    (positions.get(left.key) ?? Number.MAX_SAFE_INTEGER)
    - (positions.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  ));
  const field = candidates.find((candidate) => (
    candidate.required !== false
    && fieldBelongsToTool(candidate, authorization.tool)
    && !completedField(candidate, collected[candidate.key], inputSchema)
  ));
  const question = text(field?.question);
  if (!field || !question) return null;
  return Object.freeze({
    key: field.key, question, kind: 'field', source: 'ui_tool_field_question',
    activeToolRequest: Object.freeze({
      id: activeRequest?.id ?? null,
      name: authorization.tool.name,
      status: 'collecting_information',
      authorizationRecordId: authorization.authorizationRecordId,
    }),
  });
}

function guidanceVariable(evidence, key) {
  const variables = evidence?.authoritativeData?.variables;
  if (!Array.isArray(variables)) return '';
  return text(variables.find((variable) => (
    toolIdentity(variable?.key) === toolIdentity(key)
  ))?.value);
}

function finalConfiguredQuestion(value) {
  const normalized = text(value, 2_000);
  if (!normalized) return '';
  const sentences = normalized.match(/[^?？]+[?？]/gu) ?? [];
  return text(sentences.at(-1));
}

function guidanceQuestion(guidanceEvidence = [], completedQuestionIdentities = new Set()) {
  for (const evidence of guidanceEvidence) {
    const data = object(evidence.authoritativeData);
    const configured = text(data.nextQuestion)
      || guidanceVariable(evidence, 'nextQuestion')
      || finalConfiguredQuestion(evidence.content);
    if (!configured || completedQuestionIdentities.has(identity(configured))) continue;
    return Object.freeze({
      key: null, question: configured, kind: 'guidance', source: 'conversation_guidance',
      guidanceRecordId: text(evidence.recordId, 120) || null,
    });
  }
  return null;
}

function selectedGuidanceQuestion(decision, guidanceEvidence = [], completedQuestionIdentities = new Set()) {
  const proposed = identity(decision.pendingQuestion);
  if (!proposed || decision.decision !== 'answer') return null;
  const configured = guidanceQuestion(guidanceEvidence, completedQuestionIdentities);
  if (!configured || identity(configured.question) !== proposed) return null;
  return Object.freeze({ ...configured, source: 'selected_conversation_guidance' });
}

function completedQuestionIdentities(fieldSchemas, collectedInformation) {
  const collected = object(collectedInformation);
  return new Set((fieldSchemas ?? []).filter((field) => (
    collected[field.key] !== undefined && collected[field.key] !== null
    && String(collected[field.key]).trim() !== ''
  )).map((field) => identity(field.question)).filter(Boolean));
}

function configuredFieldQuestionMatch(value, fieldSchemas = []) {
  const candidate = identity(value);
  if (!candidate) return null;
  return (fieldSchemas ?? []).filter((field) => Boolean(field.requiredAction)).find((field) => {
    const question = identity(field.question);
    if (!question) return false;
    if (candidate.includes(question) || question.includes(candidate)) return true;
    const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
    const questionTokens = question.split(' ').filter(Boolean);
    return questionTokens.length > 1
      && questionTokens.filter((part) => candidateTokens.has(part)).length / questionTokens.length >= 0.75;
  }) ?? null;
}

export function validateConfiguredFieldCollectionSpeech(value, {
  fieldSchemas = [], activeToolAuthorized = false,
} = {}) {
  const field = configuredFieldQuestionMatch(value, fieldSchemas);
  if (!field || activeToolAuthorized) return Object.freeze({ valid: true });
  return Object.freeze({
    valid: false, reason: 'premature_configured_field_collection', field: field.key,
  });
}

export function resolveNextConfiguredQuestion({
  decision = {}, beforeState = {}, afterState = {}, fieldSchemas = [], tools = [],
  actionEvidence = [], guidanceEvidence = [], confirmationConfiguration = null,
} = {}) {
  const collected = afterState.collectedInformation ?? afterState.collectedData ?? {};
  const completed = completedQuestionIdentities(fieldSchemas, collected);
  const activeRequest = afterState.activeToolRequest
    ?? decision.activeToolRequest ?? beforeState.activeToolRequest ?? null;
  const fieldQuestion = nextToolField({
    activeRequest, fieldSchemas, collectedInformation: collected, tools, actionEvidence,
  });
  if (fieldQuestion) return fieldQuestion;
  const confirmation = confirmationForTool({
    activeRequest, fieldSchemas, collectedInformation: collected, tools, actionEvidence,
    configuration: confirmationConfiguration,
  });
  if (confirmation) return confirmation;

  // A clarification is part of the single grounded decision, not a backend
  // business question. It is allowed only when the validator selected the
  // explicit clarify decision and limited it to one pending question.
  const clarification = decision.decision === 'clarify'
    ? pending(decision.pendingQuestion) : null;
  if (clarification) return Object.freeze({
    ...clarification,
    source: 'grounded_clarification',
  });

  const savedPending = pending(beforeState.pendingQuestion ?? (
    beforeState.pendingQuestionText
      ? { key: beforeState.pendingQuestion, text: beforeState.pendingQuestionText, kind: beforeState.pendingQuestionKind }
      : null
  ));
  const savedPendingIsActionState = ['field', 'confirmation'].includes(savedPending?.kind)
    && Boolean(activeRequest);
  const contextualContinuation = decision.stateUpdate?.contextDependent === true
    || decision.contextDependent === true;
  if (decision.pendingQuestionRelevant !== false && savedPending
    && (savedPendingIsActionState || contextualContinuation)
    && !completed.has(identity(savedPending.question))) return savedPending;

  // Conversation guidance is appended only when the grounded decision chose
  // that exact configured question. Never append the first retrieved guidance
  // record merely because it happened to rank in the evidence set.
  const guidance = selectedGuidanceQuestion(decision, guidanceEvidence, completed);
  if (!guidance) return null;
  const guidanceCollection = validateConfiguredFieldCollectionSpeech(guidance.question, {
    fieldSchemas,
    activeToolAuthorized: Boolean(authorizedTool(activeRequest, tools, actionEvidence)),
  });
  return guidanceCollection.valid ? guidance : null;
}

function sentenceParts(value) {
  const normalized = text(value, 4_000);
  if (!normalized) return [];
  if (globalThis.Intl?.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(normalized)]
      .map((entry) => entry.segment.trim()).filter(Boolean);
  }
  return normalized.split(/(?<=[.!?？])\s+/u).map((entry) => entry.trim()).filter(Boolean);
}

export function composeConfiguredTurnResponse(answer, nextQuestion) {
  const configured = text(nextQuestion?.question);
  const answerParts = sentenceParts(answer).filter((part) => !/[?？]\s*$/u.test(part));
  if (configured && !answerParts.some((part) => identity(part) === identity(configured))) {
    answerParts.push(configured);
  }
  return answerParts.join(' ').trim();
}
