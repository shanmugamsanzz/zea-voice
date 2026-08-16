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
    configuration.actionKey, configuration.key,
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
  const required = tool.configuration?.inputSchema?.required
    ?? tool.configuration?.input_schema?.required ?? [];
  return Array.isArray(required) && required.includes(field.key);
}

function nextToolField({ activeRequest, fieldSchemas, collectedInformation, tools, actionEvidence }) {
  const authorization = authorizedTool(activeRequest, tools, actionEvidence);
  if (!authorization) return null;
  const collected = object(collectedInformation);
  const field = (fieldSchemas ?? []).find((candidate) => (
    candidate.required !== false
    && fieldBelongsToTool(candidate, authorization.tool)
    && (collected[candidate.key] === undefined || collected[candidate.key] === null
      || String(collected[candidate.key]).trim() === '')
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

function completedQuestionIdentities(fieldSchemas, collectedInformation) {
  const collected = object(collectedInformation);
  return new Set((fieldSchemas ?? []).filter((field) => (
    collected[field.key] !== undefined && collected[field.key] !== null
    && String(collected[field.key]).trim() !== ''
  )).map((field) => identity(field.question)).filter(Boolean));
}

export function resolveNextConfiguredQuestion({
  decision = {}, beforeState = {}, afterState = {}, fieldSchemas = [], tools = [],
  actionEvidence = [], guidanceEvidence = [],
} = {}) {
  const collected = afterState.collectedInformation ?? afterState.collectedData ?? {};
  const completed = completedQuestionIdentities(fieldSchemas, collected);
  const activeRequest = decision.activeToolRequest
    ?? afterState.activeToolRequest ?? beforeState.activeToolRequest ?? null;
  const fieldQuestion = nextToolField({
    activeRequest, fieldSchemas, collectedInformation: collected, tools, actionEvidence,
  });
  if (fieldQuestion) return fieldQuestion;

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
  if (decision.pendingQuestionRelevant !== false && savedPending
    && !completed.has(identity(savedPending.question))) return savedPending;

  return guidanceQuestion(guidanceEvidence, completed);
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
