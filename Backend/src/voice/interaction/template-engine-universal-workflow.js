import { AppError } from '../../middleware/errors.js';
import { assertExplicitAction } from './universal-response-safety.js';
import { toolArgumentsMatchSchema, validateToolArguments } from '../tools/tool-security.js';

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function jsonClone(value, fallback = {}) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
}

function hasConfiguredFields(schema) {
  return Object.keys(object(schema?.properties)).length > 0
    || (Array.isArray(schema?.required) && schema.required.length > 0);
}

export function buildUniversalWorkflowDefinitions({
  authorizedTools = [],
} = {}) {
  const tools = Array.isArray(authorizedTools) ? authorizedTools : [];
  return Object.freeze(tools.map((tool) => {
    const configuredSchema = jsonClone(tool.inputSchema, {});
    const promptDriven = !hasConfiguredFields(configuredSchema);
    const inputSchema = promptDriven
      ? { type: 'object', properties: {}, required: [], additionalProperties: true }
      : configuredSchema;
    const schemaRequired = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    const requiredFields = [...new Set(schemaRequired)];
    return Object.freeze({
      workflowId: cleanText(tool.id, 160), toolName: cleanText(tool.name, 160),
      identifiers: Object.freeze((tool.identifiers ?? []).map((value) => cleanText(value, 160))
        .filter(Boolean)),
      description: cleanText(tool.description, 1_024),
      inputSchema: Object.freeze(inputSchema),
      requiredFields: Object.freeze(requiredFields),
      promptDriven,
    });
  }).filter((workflow) => workflow.workflowId && workflow.toolName));
}

function definitionFor(action, definitions) {
  const matches = definitions.filter((definition) => (
    definition.workflowId === action.workflowId && definition.toolName === action.toolName
  ));
  if (matches.length !== 1) throw new AppError(409,
    'The requested workflow action is not uniquely authorized',
    'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_AUTHORIZED');
  return matches[0];
}

function validatePartialArguments(values, definition) {
  if (definition.promptDriven) {
    return validateToolArguments(values, definition.inputSchema);
  }
  const properties = object(definition.inputSchema?.properties);
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(properties, key) || !toolArgumentsMatchSchema(value, properties[key])) {
      throw new AppError(502, 'The workflow action contains an invalid configured field',
        'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_ARGUMENTS_INVALID', { field: key });
    }
  }
  return values;
}

function workflowState(state, values, status, workflowId, confirmationPrompt = null) {
  return Object.freeze({ ...state, activeWorkflowId: workflowId,
    collectedToolFields: Object.freeze({ ...values }), confirmationStatus: status, confirmationPrompt });
}

export async function applyUniversalWorkflowResult({
  outcome, workflowAction, state = {}, definitions = [], persistWorkflowState,
  executeAuthorizedTool,
  conversationContext, speech,
} = {}) {
  if (outcome === 'WORKFLOW_CANCELLATION') {
    const nextState = workflowState(state, {}, null, null);
    await persistWorkflowState?.(nextState);
    return Object.freeze({ state: nextState, workflow: Object.freeze({ status: 'cancelled' }),
      toolExecuted: false, toolResult: null });
  }
  if (outcome !== 'WORKFLOW_ACTION') {
    return Object.freeze({ state, workflow: null, toolExecuted: false, toolResult: null });
  }
  const definition = definitionFor(workflowAction, definitions);
  const activeWorkflowId = cleanText(state.activeWorkflowId, 160);
  if (workflowAction.action === 'UPSERT'
    && activeWorkflowId && activeWorkflowId !== definition.workflowId) {
    throw new AppError(409, 'A different configured workflow is already active',
      'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_CONFLICT');
  }
  const supplied = validatePartialArguments(object(workflowAction.arguments), definition);
  if (workflowAction.action === 'UPSERT') {
    const collected = { ...object(state.collectedToolFields), ...supplied };
    const missingFields = definition.requiredFields.filter((field) => !Object.hasOwn(collected, field)
      || collected[field] == null || typeof collected[field] === 'string' && !collected[field].trim());
    const status = missingFields.length ? 'pending_fields' : 'awaiting_confirmation';
    const nextState = workflowState(state, collected, status, definition.workflowId,
      status === 'awaiting_confirmation' ? cleanText(speech, 4000) || null : null);
    await persistWorkflowState?.(nextState);
    return Object.freeze({ state: nextState,
      workflow: Object.freeze({ id: definition.workflowId, status,
        nextField: missingFields[0] ?? null }), toolExecuted: false, toolResult: null });
  }
  assertExplicitAction({
    intent: 'execute', utteranceComplete: true, unambiguous: true,
    quote: workflowAction.authorizationQuote,
  }, 'execute', conversationContext);
  // The configured prompt controls when a tool should run. A read-only tool
  // (for example, slot checking) can therefore run after the caller provides
  // its required inputs, while a booking prompt can still ask for confirmation
  // before it emits EXECUTE. Authorization remains enforced by tool identity.
  const argumentsValue = activeWorkflowId === definition.workflowId
    ? { ...object(state.collectedToolFields), ...supplied }
    : supplied;
  const missingFields = definition.requiredFields.filter((field) => !Object.hasOwn(argumentsValue, field)
    || argumentsValue[field] == null || typeof argumentsValue[field] === 'string' && !argumentsValue[field].trim());
  if (missingFields.length) {
    throw new AppError(409, 'The configured workflow cannot execute before required fields are collected',
      'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_READY', { missingFields });
  }
  if (typeof executeAuthorizedTool !== 'function') {
    throw new AppError(500, 'Configured workflow tool execution is unavailable',
      'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_EXECUTOR_MISSING');
  }
  const validatedArguments = validateToolArguments(argumentsValue, definition.inputSchema);
  const toolResult = await executeAuthorizedTool(Object.freeze({
    name: definition.toolName, arguments: validatedArguments,
    authorizationRecordId: definition.workflowId,
    intent: cleanText(conversationContext?.currentQuestion, 2_000),
    currentUserMessage: cleanText(conversationContext?.currentQuestion, 2_000),
    conversation: conversationContext?.recentConversation ?? [],
    collectedDetails: argumentsValue,
  }));
  if (!toolResult?.success) throw new AppError(502, 'The configured workflow tool failed',
    'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_TOOL_FAILED');
  const nextState = activeWorkflowId === definition.workflowId
    ? workflowState(state, {}, null, null) : state;
  await persistWorkflowState?.(nextState);
  return Object.freeze({ state: nextState,
    workflow: Object.freeze({ id: definition.workflowId, status: 'completed' }),
    toolExecuted: true, toolResult });
}
