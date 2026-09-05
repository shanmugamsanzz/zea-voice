import { AppError } from '../../middleware/errors.js';
import {
  assignedToolIdentifiers,
  assignedToolInputSchema,
  configuredWorkflowToolIdentifier,
} from '../../knowledge-bases/workflow-tool-authorization.js';
import { validateToolArguments, toolArgumentsMatchSchema } from '../tools/tool-security.js';
import { validateTemplateEngineDecision } from './template-engine-decision-contract.js';
import { validateTemplateEngineToolResultSpeech } from './template-engine-tool-result-validator.js';
import { validateAndComposeTemplateEngineSpeech } from './template-engine-follow-up.js';

export const TEMPLATE_ENGINE_WORKFLOW_RUNTIME_VERSION = 4;

const speechTasks = new Set(['ASK_FIELD', 'CONFIRM', 'RESULT']);

function cleanText(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return cleanText(value, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function publishedInScope(workflow, scope) {
  const publicationKey = `${cleanText(workflow.knowledgeBaseId, 160).toLocaleLowerCase()}`
    + `:${Number(workflow.publicationRevision)}`;
  const publications = new Set((scope.publications ?? []).map((entry) => (
    `${cleanText(entry?.knowledgeBaseId, 160).toLocaleLowerCase()}`
      + `:${Number(entry?.publicationRevision)}`
  )));
  const status = cleanText(workflow.status ?? workflow.publicationStatus, 40).toLocaleLowerCase();
  return cleanText(scope.tenantId, 160)
    && cleanText(scope.agentId, 160)
    && cleanText(workflow.tenantId, 160).toLocaleLowerCase()
      === cleanText(scope.tenantId, 160).toLocaleLowerCase()
    && (!workflow.agentId || cleanText(workflow.agentId, 160).toLocaleLowerCase()
      === cleanText(scope.agentId, 160).toLocaleLowerCase())
    && publications.has(publicationKey)
    && cleanText(workflow.recordType, 80).toLocaleUpperCase() === 'WORKFLOW_RULE'
    && (workflow.published === true || ['approved', 'published'].includes(status));
}

function toolActive(tool) {
  const status = cleanText(tool?.status ?? 'active', 40).toLocaleLowerCase();
  return status === 'active' && assignedToolInputSchema(tool).type === 'object';
}

function fieldKey(field) {
  return cleanText(field?.key ?? field?.name, 64);
}

function fieldAssignedToTool(field, tool) {
  const requiredAction = identity(field?.requiredAction);
  return !requiredAction || assignedToolIdentifiers(tool).has(requiredAction);
}

function fieldsForTool(informationFields, tool, schema) {
  const required = Array.isArray(schema.required) ? schema.required.map((key) => cleanText(key, 64)) : [];
  const requiredSet = new Set(required);
  const properties = object(schema.properties);
  const configured = (informationFields ?? []).filter((field) => (
    fieldAssignedToTool(field, tool) && requiredSet.has(fieldKey(field))
  ));
  const byKey = new Map(configured.map((field) => [fieldKey(field), field]));
  const missingConfiguration = required.filter((key) => !Object.hasOwn(properties, key)
    || !byKey.has(key)
    || !cleanText(byKey.get(key)?.question, 1_000));
  if (missingConfiguration.length) {
    throw new AppError(409, 'Required tool fields must have UI field configuration and questions',
      'TEMPLATE_ENGINE_WORKFLOW_FIELD_CONFIGURATION_MISSING', {
        fields: missingConfiguration,
      });
  }
  return Object.freeze(configured.map((field) => {
    const key = fieldKey(field);
    return Object.freeze({
      ...field, key,
      label: cleanText(field?.label ?? key, 160),
      question: cleanText(field?.question, 1_000),
    });
  }));
}

function resolveConfiguration({
  toolDecision = null, state = {}, publishedWorkflows = [], assignedTools = [],
  informationFields = [], scope = {},
} = {}) {
  const activeWorkflowId = cleanText(state.activeWorkflowId, 160);
  const validatedDecision = toolDecision === null ? null : validateTemplateEngineDecision(toolDecision);
  if (!activeWorkflowId && (!validatedDecision?.valid
    || validatedDecision.value.decision !== 'TOOL')) {
    throw new TypeError('Workflow activation requires a valid TOOL decision');
  }
  const requestedTool = identity(validatedDecision?.value?.tool?.name);
  const workflows = publishedWorkflows.filter((workflow) => publishedInScope(workflow, scope));
  const eligible = workflows.flatMap((workflow) => {
    const workflowId = cleanText(workflow.recordId ?? workflow.id, 160);
    const workflowTool = identity(configuredWorkflowToolIdentifier(workflow));
    if (!workflowId || !workflowTool || (activeWorkflowId
      && workflowId !== activeWorkflowId)) return [];
    const tools = assignedTools.filter((tool) => toolActive(tool)
      && assignedToolIdentifiers(tool).has(workflowTool)
      && (!requestedTool || assignedToolIdentifiers(tool).has(requestedTool)));
    if (!activeWorkflowId && (!requestedTool || tools.length !== 1)) return [];
    return tools.length === 1 ? [{ workflow, workflowId, tool: tools[0] }] : [];
  });
  if (eligible.length !== 1) {
    throw new AppError(409, 'The requested Workflow is not uniquely authorized',
      'TEMPLATE_ENGINE_WORKFLOW_NOT_AUTHORIZED');
  }
  const selected = eligible[0];
  const inputSchema = assignedToolInputSchema(selected.tool);
  const fields = fieldsForTool(informationFields, selected.tool, inputSchema);
  return Object.freeze({ ...selected, inputSchema, fields });
}

function selectValue(value, field) {
  if (cleanText(field.type, 40).toLocaleLowerCase() !== 'select') return value;
  const wanted = cleanText(value, 500).toLocaleLowerCase();
  for (const option of field.options ?? []) {
    const aliases = [option?.value, option?.label, ...(option?.aliases ?? [])]
      .map((entry) => cleanText(entry, 500).toLocaleLowerCase()).filter(Boolean);
    if (aliases.includes(wanted)) return option.value;
  }
  return value;
}

function typedValue(value, property, field) {
  const selected = selectValue(value, field);
  const types = Array.isArray(property?.type) ? property.type : [property?.type];
  if (types.includes('integer') && typeof selected === 'string'
    && /^[-+]?\d+$/u.test(selected.trim())) return Number.parseInt(selected, 10);
  if (types.includes('number') && typeof selected === 'string'
    && /^[-+]?(?:\d+\.?\d*|\.\d+)$/u.test(selected.trim())) return Number(selected);
  if (types.includes('boolean') && typeof selected === 'string') {
    const normalized = selected.trim().toLocaleLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return selected;
}

function fieldValueValid(value, field, property) {
  if (!toolArgumentsMatchSchema(value, property)) return false;
  const type = cleanText(field.type, 40).toLocaleLowerCase();
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(value))) return false;
  if (type === 'phone' && !/^\+?[\d\s()-]{8,25}$/u.test(String(value))) return false;
  return true;
}

function stateFor(configuration, collectedToolFields, confirmationStatus, selectedRecordIds = []) {
  return Object.freeze({
    activeWorkflowId: configuration.workflowId,
    collectedToolFields: Object.freeze({ ...collectedToolFields }),
    confirmationStatus,
    selectedRecordIds: Object.freeze([...new Set((selectedRecordIds ?? [])
      .map((value) => cleanText(value, 160)).filter(Boolean))]),
  });
}

function workflowProgress(configuration, state) {
  const fields = object(state.collectedToolFields);
  const properties = object(configuration.inputSchema.properties);
  const missingFields = configuration.fields.filter((field) => (
    !Object.hasOwn(fields, field.key)
    || !fieldValueValid(fields[field.key], field, properties[field.key])
  ));
  return Object.freeze({
    missingFields: Object.freeze(missingFields),
    nextField: missingFields[0] ?? null,
    complete: missingFields.length === 0,
  });
}

export function activateTemplateEngineWorkflow(input = {}) {
  const configuration = resolveConfiguration(input);
  const collected = object(input.state?.collectedToolFields);
  const selectedRecordIds = input.selectedRecordIds ?? input.state?.selectedRecordIds ?? [];
  const state = stateFor(configuration, collected, 'pending_fields', selectedRecordIds);
  const progress = workflowProgress(configuration, state);
  return Object.freeze({
    configuration, state: progress.complete
      ? stateFor(configuration, collected, 'awaiting_confirmation', selectedRecordIds) : state,
    progress,
  });
}

export function collectTemplateEngineWorkflowFields(input = {}) {
  const configuration = resolveConfiguration(input);
  const collected = { ...object(input.state?.collectedToolFields) };
  const selectedRecordIds = input.selectedRecordIds ?? input.state?.selectedRecordIds ?? [];
  const candidates = object(input.candidateValues);
  if (Object.keys(candidates).length && input.candidateValuesVerified !== true) {
    throw new TypeError('Workflow field candidates must come from the verified caller input');
  }
  const rejectedFields = [];
  const properties = object(configuration.inputSchema.properties);
  for (const field of configuration.fields) {
    if (!Object.hasOwn(candidates, field.key)) continue;
    const value = typedValue(candidates[field.key], properties[field.key], field);
    if (!fieldValueValid(value, field, properties[field.key])) {
      rejectedFields.push(field.key);
    } else collected[field.key] = value;
  }
  const provisional = stateFor(configuration, collected, 'pending_fields', selectedRecordIds);
  const progress = workflowProgress(configuration, provisional);
  const state = progress.complete
    ? stateFor(configuration, collected, 'awaiting_confirmation', selectedRecordIds) : provisional;
  return Object.freeze({
    configuration, state, progress,
    acceptedFields: Object.freeze(configuration.fields.map((field) => field.key)
      .filter((key) => Object.hasOwn(candidates, key)
        && Object.hasOwn(collected, key) && !rejectedFields.includes(key))),
    rejectedFields: Object.freeze(rejectedFields),
  });
}

export const templateEngineWorkflowSpeechJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['speech']),
  properties: Object.freeze({
    speech: Object.freeze({ type: 'string' }),
  }),
});

const nullableTextSchema = Object.freeze({
  anyOf: Object.freeze([
    Object.freeze({ type: 'string' }),
    Object.freeze({ type: 'null' }),
  ]),
});

export const templateEngineWorkflowResultSpeechJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['speech', 'nextQuestion']),
  properties: Object.freeze({
    speech: Object.freeze({ type: 'string' }),
    nextQuestion: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({
          type: 'object', additionalProperties: false,
          required: Object.freeze(['question', 'reason']),
          properties: Object.freeze({
            question: Object.freeze({ type: 'string' }),
            reason: nullableTextSchema,
          }),
        }),
      ]),
    }),
  }),
});

function safeJson(value, maximumCharacters = 8_000) {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length > maximumCharacters) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function configuredConfirmation(value, configuration) {
  return cleanText(value
    ?? configuration.inputSchema['x-confirmation-message']
    ?? configuration.workflow.actionConfig?.confirmationMessage
    ?? configuration.workflow.authoritativeData?.actionConfig?.confirmationMessage,
  2_000);
}

function configuredWorkflowBehavior(configuration) {
  return safeJson(
    configuration.workflow.actionConfig
      ?? configuration.workflow.authoritativeData?.actionConfig
      ?? {},
  );
}

export function createTemplateEngineWorkflowSpeechTask({
  configuration, state, confirmationMessage = null, verifiedResult = null,
  conversationGuidance = null,
} = {}) {
  if (!configuration?.workflowId || !configuration?.inputSchema) {
    throw new TypeError('Workflow speech requires resolved runtime configuration');
  }
  if (verifiedResult !== null) {
    if (!verifiedResult || typeof verifiedResult !== 'object'
      || verifiedResult.verified !== true || typeof verifiedResult.success !== 'boolean') {
      throw new TypeError('Workflow result speech requires a verified runtime result');
    }
    return Object.freeze({
      type: 'RESULT',
      success: verifiedResult.success,
      output: safeJson(verifiedResult.output),
      error: verifiedResult.success ? null : safeJson(verifiedResult.error),
      configuredWorkflowBehavior: configuredWorkflowBehavior(configuration),
      conversationGuidance: conversationGuidance?.purpose ? Object.freeze({
        recordId: cleanText(conversationGuidance.recordId, 160) || null,
        purpose: cleanText(conversationGuidance.purpose, 1_500),
        nextQuestion: cleanText(conversationGuidance.nextQuestion, 1_000) || null,
      }) : null,
    });
  }
  const progress = workflowProgress(configuration, state);
  if (progress.nextField) {
    return Object.freeze({
      type: 'ASK_FIELD',
      field: Object.freeze({
        key: progress.nextField.key,
        label: progress.nextField.label,
        configuredQuestion: progress.nextField.question,
      }),
    });
  }
  if (state.confirmationStatus !== 'awaiting_confirmation') {
    throw new TypeError('Completed Workflow fields must await explicit confirmation');
  }
  const message = configuredConfirmation(confirmationMessage, configuration);
  if (!message) {
    throw new AppError(409, 'A UI confirmation message is required before tool execution',
      'TEMPLATE_ENGINE_WORKFLOW_CONFIRMATION_CONFIGURATION_MISSING');
  }
  return Object.freeze({
    type: 'CONFIRM',
    values: Object.freeze(configuration.fields.map((field) => Object.freeze({
      key: field.key,
      label: field.label,
      value: state.collectedToolFields[field.key],
    }))),
    configuredMessage: message,
    configuredWorkflowBehavior: configuredWorkflowBehavior(configuration),
  });
}

function workflowFieldCacheDescriptor(configuration, task, language) {
  if (task?.type !== 'ASK_FIELD') return null;
  return Object.freeze({
    workflowRecordId: configuration.workflowId,
    knowledgeBaseId: cleanText(configuration.workflow.knowledgeBaseId, 160),
    publicationRevision: Number(configuration.workflow.publicationRevision),
    toolId: cleanText(configuration.tool.id ?? configuration.tool.name, 160),
    fieldKey: task.field.key,
    configuredQuestion: task.field.configuredQuestion,
    language: cleanText(language, 80) || null,
  });
}

function speechOutput(value) {
  const direct = value && typeof value === 'object'
    ? value.outputParsed ?? value.output_parsed ?? value.parsed
      ?? value.answer ?? value.output ?? value.text ?? value
    : value;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  if (typeof direct !== 'string') return null;
  const raw = direct.trim();
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function phraseTemplateEngineWorkflowSpeech({
  mainPrompt, task, cacheDescriptor = null,
} = {}, dependencies = {}) {
  if (!speechTasks.has(task?.type)) throw new TypeError('Unsupported Workflow speech task');
  const prompt = cleanText(mainPrompt, 24_000);
  if (!prompt) throw new TypeError('Workflow speech requires the tenant main prompt');
  if (task.type === 'ASK_FIELD' && cacheDescriptor
    && typeof dependencies.getCachedWorkflowSpeech === 'function') {
    const cached = await dependencies.getCachedWorkflowSpeech(cacheDescriptor);
    const cachedSpeech = cleanText(cached?.speech, 4_000);
    if (cachedSpeech) {
      return Object.freeze({
        speech: cachedSpeech, nextQuestion: null, taskType: task.type,
        cacheHit: true, cacheDescriptor, cachedAudio: cached.audio ?? null,
      });
    }
  }
  if (typeof dependencies.invokeStructuredLlm !== 'function') {
    throw new TypeError('Workflow speech requires one structured LLM invoker');
  }
  const systemPrompt = [
    'You phrase caller-facing speech for a deterministic Workflow runtime.',
    'The runtime owns required fields, validation, completion, authorization, confirmation, execution and result status.',
    'Do not add, change or infer field values. Do not claim execution or success unless the supplied task is RESULT with success true.',
    'For ASK_FIELD, naturally phrase only the configured field question.',
    'For CONFIRM, read back every supplied value once and use the supplied configured message to request explicit confirmation.',
    'For RESULT, follow the published configured Workflow behavior using only the supplied verified result status, output and error.',
    'Only RESULT may include nextQuestion. Generate at most one natural question from the supplied Conversation Guidance. Keep it null when guidance is missing, has no nextQuestion, or is not relevant.',
    'ASK_FIELD and CONFIRM use the runtime-controlled speech-only schema and must not add a normal conversational follow-up.',
    'Follow the tenant main prompt for language, tone and style when it does not conflict with these runtime rules.',
    '<tenant_main_prompt_json>',
    JSON.stringify(prompt),
    '</tenant_main_prompt_json>',
    '<workflow_speech_task>',
    JSON.stringify(task),
    '</workflow_speech_task>',
    'Return exactly one JSON object matching the provider schema.',
  ].join('\n');
  const completion = await dependencies.invokeStructuredLlm(Object.freeze({
    messages: Object.freeze([Object.freeze({ role: 'system', content: systemPrompt })]),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema', name: 'template_engine_workflow_speech', strict: true,
      schema: task.type === 'RESULT'
        ? templateEngineWorkflowResultSpeechJsonSchema
        : templateEngineWorkflowSpeechJsonSchema,
    }),
  }));
  const output = speechOutput(completion);
  const expectedKeys = task.type === 'RESULT' ? ['nextQuestion', 'speech'] : ['speech'];
  if (!output || Object.keys(output).sort().join('|') !== expectedKeys.sort().join('|')) {
    throw new AppError(502, 'The Workflow speech LLM returned an invalid object',
      'TEMPLATE_ENGINE_WORKFLOW_SPEECH_INVALID');
  }
  const speech = cleanText(output.speech, 4_000);
  if (!speech) {
    throw new AppError(502, 'The Workflow speech LLM returned empty speech',
      'TEMPLATE_ENGINE_WORKFLOW_SPEECH_INVALID');
  }
  let nextQuestion = null;
  if (task.type === 'RESULT' && output.nextQuestion !== null) {
    const value = output.nextQuestion;
    const keys = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort().join('|') : '';
    const question = cleanText(value?.question, 1_000);
    const reason = value?.reason === null ? null : cleanText(value?.reason, 500);
    if (keys !== 'question|reason' || !question
      || (value?.reason !== null && !reason)) {
      throw new AppError(502, 'The Workflow result follow-up is invalid',
        'TEMPLATE_ENGINE_WORKFLOW_SPEECH_INVALID');
    }
    nextQuestion = Object.freeze({ question, reason });
  }
  if (task.type === 'ASK_FIELD' && cacheDescriptor
    && typeof dependencies.cacheWorkflowSpeech === 'function') {
    await dependencies.cacheWorkflowSpeech(cacheDescriptor, speech);
  }
  return Object.freeze({
    speech, nextQuestion, taskType: task.type,
    cacheHit: false, cacheDescriptor, cachedAudio: null,
  });
}

export async function executeTemplateEngineWorkflow(input = {}, dependencies = {}) {
  const configuration = resolveConfiguration(input);
  const state = stateFor(
    configuration,
    object(input.state?.collectedToolFields),
    cleanText(input.state?.confirmationStatus, 40),
    input.selectedRecordIds ?? input.state?.selectedRecordIds ?? [],
  );
  const progress = workflowProgress(configuration, state);
  const explicitConfirmation = input.confirmation?.accepted === true
    && input.confirmation?.explicit === true;
  if (!progress.complete || state.confirmationStatus !== 'awaiting_confirmation'
    || !explicitConfirmation) {
    throw new AppError(409, 'Explicit confirmation is required before tool execution',
      'TEMPLATE_ENGINE_WORKFLOW_CONFIRMATION_REQUIRED');
  }
  const argumentsValue = validateToolArguments(
    state.collectedToolFields, configuration.inputSchema,
  );
  if (typeof dependencies.executeAuthorizedTool !== 'function') {
    throw new TypeError('Workflow execution requires an authorized tool executor');
  }
  const result = await dependencies.executeAuthorizedTool(Object.freeze({
    name: configuration.tool.name,
    arguments: Object.freeze({ ...argumentsValue }),
    authorizationRecordId: configuration.workflowId,
    workflowRecord: configuration.workflow,
    assignedTool: configuration.tool,
    selectedRecordIds: state.selectedRecordIds,
  }));
  if (!result || typeof result !== 'object' || result.verified !== true
    || typeof result.success !== 'boolean') {
    throw new AppError(502, 'Tool execution did not return a verified result',
      'TEMPLATE_ENGINE_WORKFLOW_RESULT_UNVERIFIED');
  }
  return Object.freeze({
    result: Object.freeze({ ...result }),
    state: result.success ? Object.freeze({
      activeWorkflowId: null,
      collectedToolFields: Object.freeze({}),
      confirmationStatus: 'executed_success',
    }) : stateFor(
      configuration, state.collectedToolFields, 'execution_failed', state.selectedRecordIds,
    ),
    configuration,
  });
}

export async function executeAndPhraseTemplateEngineWorkflow(input = {}, dependencies = {}) {
  const execution = await executeTemplateEngineWorkflow(input, dependencies);
  const task = createTemplateEngineWorkflowSpeechTask({
    configuration: execution.configuration,
    state: input.state,
    verifiedResult: execution.result,
    conversationGuidance: input.conversationGuidance,
  });
  const phrased = await phraseTemplateEngineWorkflowSpeech({
    mainPrompt: input.mainPrompt, task,
  }, dependencies);
  const semanticClaimValidation = typeof dependencies.validateToolResultSpeechClaims === 'function'
    ? await dependencies.validateToolResultSpeechClaims(Object.freeze({
      speech: phrased.speech,
      verifiedResult: execution.result,
      workflowRecordId: execution.configuration.workflowId,
    })) : null;
  const validatedSpeech = validateTemplateEngineToolResultSpeech({
    speech: phrased.speech,
    verifiedResult: execution.result,
    successIndicators: input.successIndicators,
    callerProvidedValues: input.state?.collectedToolFields,
    semanticClaimValidation,
  });
  if (!validatedSpeech.valid) {
    throw new AppError(502, 'The Workflow result speech failed grounding validation',
      'TEMPLATE_ENGINE_WORKFLOW_RESULT_SPEECH_INVALID', {
        reason: validatedSpeech.reason,
      });
  }
  const followUpClaimValidation = phrased.nextQuestion
    && typeof dependencies.validateToolResultSpeechClaims === 'function'
    ? await dependencies.validateToolResultSpeechClaims(Object.freeze({
      speech: phrased.nextQuestion.question,
      verifiedResult: execution.result,
      workflowRecordId: execution.configuration.workflowId,
    })) : { supported: true };
  const composed = validateAndComposeTemplateEngineSpeech({
    decision: Object.freeze({
      decision: 'RESPONSE', response: validatedSpeech.value.speech,
      clarification: null, search: null, tool: null,
      nextQuestion: phrased.nextQuestion, stateUpdate: null,
    }),
    conversationGuidance: input.conversationGuidance,
    suppressFollowUp: input.cancelled === true || input.callComplete === true,
    claimsValidated: followUpClaimValidation?.supported === true,
  });
  return Object.freeze({
    ...execution, speech: composed.speech, speechTask: task,
    nextQuestion: composed.decision.nextQuestion,
    followUpValidation: composed.followUp,
  });
}

export async function advanceTemplateEngineWorkflowTurn(input = {}, dependencies = {}) {
  const priorAwaitedConfirmation = input.state?.confirmationStatus === 'awaiting_confirmation';
  if (input.state?.confirmationStatus === 'executing') {
    throw new AppError(409, 'The Workflow execution is already in progress',
      'TEMPLATE_ENGINE_WORKFLOW_EXECUTION_IN_PROGRESS');
  }
  if (typeof dependencies.persistWorkflowState !== 'function') {
    throw new TypeError('The Workflow turn requires a state persistence adapter');
  }
  let transition;
  if (input.state?.activeWorkflowId) {
    transition = collectTemplateEngineWorkflowFields(input);
  } else {
    const activated = activateTemplateEngineWorkflow(input);
    transition = Object.keys(object(input.candidateValues)).length
      ? collectTemplateEngineWorkflowFields({ ...input, state: activated.state })
      : activated;
  }

  const explicitConfirmation = input.confirmation?.accepted === true
    && input.confirmation?.explicit === true;
  if (priorAwaitedConfirmation && explicitConfirmation
    && transition.progress.complete) {
    const executingState = stateFor(
      transition.configuration,
      transition.state.collectedToolFields,
      'executing',
      transition.state.selectedRecordIds,
    );
    await dependencies.persistWorkflowState(executingState);
    const execution = await executeAndPhraseTemplateEngineWorkflow({
      ...input,
      state: transition.state,
    }, dependencies);
    await dependencies.persistWorkflowState(execution.state);
    return Object.freeze({
      status: execution.result.success ? 'SUCCEEDED' : 'FAILED',
      state: execution.state,
      speech: execution.speech,
      workflowRecordId: execution.configuration.workflowId,
      toolId: execution.configuration.tool.id ?? execution.configuration.tool.name,
      verifiedResult: execution.result,
      nextQuestion: execution.nextQuestion,
      followUpValidation: execution.followUpValidation,
    });
  }

  const task = createTemplateEngineWorkflowSpeechTask({
    configuration: transition.configuration,
    state: transition.state,
    confirmationMessage: input.confirmationMessage,
  });
  await dependencies.persistWorkflowState(transition.state);
  const cacheDescriptor = workflowFieldCacheDescriptor(
    transition.configuration, task, input.language,
  );
  const phrased = await phraseTemplateEngineWorkflowSpeech({
    mainPrompt: input.mainPrompt,
    task,
    cacheDescriptor,
  }, dependencies);
  return Object.freeze({
    status: task.type === 'ASK_FIELD' ? 'AWAITING_FIELD' : 'AWAITING_CONFIRMATION',
    state: transition.state,
    speech: phrased.speech,
    workflowRecordId: transition.configuration.workflowId,
    toolId: transition.configuration.tool.id ?? transition.configuration.tool.name,
    speechTask: task,
    speechCache: cacheDescriptor ? Object.freeze({
      descriptor: cacheDescriptor,
      hit: phrased.cacheHit === true,
      audio: phrased.cachedAudio ?? null,
    }) : null,
    acceptedFields: transition.acceptedFields ?? Object.freeze([]),
    rejectedFields: transition.rejectedFields ?? Object.freeze([]),
    verifiedResult: null,
    nextQuestion: null,
    followUpValidation: Object.freeze({ accepted: false, reason: 'workflow_in_progress' }),
  });
}
