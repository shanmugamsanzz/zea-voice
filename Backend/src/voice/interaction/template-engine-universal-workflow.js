import { AppError } from '../../middleware/errors.js';
import { isDeepStrictEqual } from 'node:util';
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

export function buildUniversalAgentConfiguration(runtimeProfile = {}) {
  const agent = object(runtimeProfile.agent);
  const settings = object(agent.settings);
  const canonical = object(runtimeProfile.configuration);
  return Object.freeze({
    identity: Object.freeze({
      name: cleanText(agent.name, 240), description: cleanText(agent.description, 2_000),
      goal: cleanText(agent.goal, 2_000), language: cleanText(agent.language, 80),
      welcomeMessage: cleanText(agent.welcomeMessage, 2_000),
    }),
    conversation: Object.freeze({
      memoryMode: cleanText(canonical.memory?.mode, 80),
      recentTurns: Number(canonical.memory?.recentTurns ?? 5),
    }),
    configuredMessages: Object.freeze({
      latencyAcknowledgementMessage: cleanText(settings.latencyAcknowledgementMessage, 500),
      technicalFailureMessage: cleanText(settings.technicalFailureMessage, 500),
    }),
  });
}

export function buildUniversalWorkflowDefinitions({
  authorizedTools = [],
} = {}) {
  const tools = Array.isArray(authorizedTools) ? authorizedTools : [];
  return Object.freeze(tools.map((tool) => {
    const schemaRequired = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
    const requiredFields = [...new Set(schemaRequired)];
    return Object.freeze({
      workflowId: cleanText(tool.id, 160), toolName: cleanText(tool.name, 160),
      identifiers: Object.freeze((tool.identifiers ?? []).map((value) => cleanText(value, 160))
        .filter(Boolean)),
      description: cleanText(tool.description, 1_024),
      inputSchema: Object.freeze(jsonClone(tool.inputSchema, {})),
      requiredFields: Object.freeze(requiredFields),
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
  if (activeWorkflowId && activeWorkflowId !== definition.workflowId) {
    throw new AppError(409, 'A different configured workflow is already active',
      'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_CONFLICT');
  }
  const supplied = validatePartialArguments(object(workflowAction.arguments), definition);
  const collected = { ...object(state.collectedToolFields), ...supplied };
  const missingFields = definition.requiredFields.filter((field) => !Object.hasOwn(collected, field)
    || collected[field] == null || typeof collected[field] === 'string' && !collected[field].trim());
  if (workflowAction.action === 'UPSERT') {
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
  const delivered = conversationContext?.lastAssistantResponse;
  if (missingFields.length || state.confirmationStatus !== 'awaiting_confirmation'
    || activeWorkflowId !== definition.workflowId
    || !state.confirmationPrompt || delivered?.completion !== 'complete'
    || cleanText(delivered.content, 4000) !== state.confirmationPrompt
    || Object.entries(supplied).some(([key, value]) => !isDeepStrictEqual(value, state.collectedToolFields?.[key]))) {
    throw new AppError(409, 'The configured workflow cannot execute before field collection and confirmation',
      'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_READY', { missingFields });
  }
  if (typeof executeAuthorizedTool !== 'function') {
    throw new AppError(500, 'Configured workflow tool execution is unavailable',
      'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_EXECUTOR_MISSING');
  }
  const argumentsValue = validateToolArguments(collected, definition.inputSchema);
  const toolResult = await executeAuthorizedTool(Object.freeze({
    name: definition.toolName, arguments: argumentsValue,
    authorizationRecordId: definition.workflowId,
  }));
  if (!toolResult?.success) throw new AppError(502, 'The configured workflow tool failed',
    'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_TOOL_FAILED');
  const nextState = workflowState(state, {}, null, null);
  await persistWorkflowState?.(nextState);
  return Object.freeze({ state: nextState,
    workflow: Object.freeze({ id: definition.workflowId, status: 'completed' }),
    toolExecuted: true, toolResult });
}
