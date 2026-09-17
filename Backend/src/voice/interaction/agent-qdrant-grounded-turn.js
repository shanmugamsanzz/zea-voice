import { AppError } from '../../middleware/errors.js';
import { retrieveAgentQdrantKnowledge } from './agent-qdrant-retrieval.js';
import { tagTemplateEngineTiming } from './template-engine-turn-timing.js';
import { shortenCompleteSpeech, assertExplicitAction } from './universal-response-safety.js';
import { llmTokenBudgetForSpeech } from './template-engine-speech-budget.js';

const outcomes = Object.freeze([
  'FACTUAL_ANSWER', 'CONVERSATIONAL_RESPONSE', 'CLARIFICATION', 'UNAVAILABLE',
  'WORKFLOW_ACTION', 'WORKFLOW_CANCELLATION', 'CLOSING',
]);

const universalTurnSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['outcome', 'speech', 'workflowAction'],
  properties: Object.freeze({
    outcome: Object.freeze({ type: 'string', enum: outcomes }),
    speech: Object.freeze({ type: 'string' }),
    workflowAction: Object.freeze({
      type: ['object', 'null'], additionalProperties: false,
      required: ['action', 'workflowId', 'toolName', 'argumentsJson', 'authorizationQuote'],
      properties: Object.freeze({
        action: Object.freeze({ type: 'string', enum: Object.freeze(['UPSERT', 'EXECUTE']) }),
        workflowId: Object.freeze({ type: 'string' }),
        toolName: Object.freeze({ type: 'string' }),
        argumentsJson: Object.freeze({ type: 'string' }),
        authorizationQuote: Object.freeze({ type: 'string' }),
      }),
    }),
  }),
});

export const AGENT_QDRANT_GROUNDED_TURN_VERSION = 5;

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function serializableObject(value, maximum = 40_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > maximum) return Object.freeze({});
    return Object.freeze(JSON.parse(serialized));
  } catch { return Object.freeze({}); }
}

function completionValue(completion) {
  const value = completion?.outputParsed ?? completion?.output_parsed ?? completion?.parsed
    ?? completion?.answer ?? completion?.output ?? completion?.text ?? completion;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(String(value ?? '')); } catch { return null; }
}

function boundedSpeech(value, maximumCharacters) {
  const configured = Number(maximumCharacters);
  const maximum = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured) : Number.MAX_SAFE_INTEGER;
  return shortenCompleteSpeech(value, maximum);
}

function evidenceRecord(chunk, tenantId, agentId) {
  return Object.freeze({
    evidenceId: chunk.id, recordId: chunk.source.documentId, recordType: 'KNOWLEDGE_CHUNK',
    canonicalName: chunk.source.filename, content: chunk.text,
    authoritativeData: Object.freeze({ text: chunk.text }), tenantId, agentId,
    documentId: chunk.source.documentId, documentName: chunk.source.filename,
    documentDisplayName: chunk.source.filename,
    sourceSection: `Chunk ${chunk.source.chunkIndex + 1}`, verified: true,
    provenanceVerified: true, evidenceStatus: 'candidate', answerSupportVerified: false,
    callerFacing: true, source: chunk.source, score: chunk.score,
  });
}

function validatedWorkflowAction(raw, outcome, workflowDefinitions) {
  if (outcome !== 'WORKFLOW_ACTION') {
    if (raw.workflowAction !== null) throw new AppError(502,
      'A non-workflow outcome cannot contain a workflow action',
      'QDRANT_UNIVERSAL_LLM_WORKFLOW_INVALID');
    return null;
  }
  const action = raw.workflowAction;
  if (!action || !['UPSERT', 'EXECUTE'].includes(action.action)) {
    throw new AppError(502, 'The workflow outcome requires a valid action',
      'QDRANT_UNIVERSAL_LLM_WORKFLOW_INVALID');
  }
  const workflowId = cleanText(action.workflowId, 160);
  const toolName = cleanText(action.toolName, 160);
  const configured = workflowDefinitions.find((workflow) => (
    workflow.workflowId === workflowId && workflow.toolName === toolName
  ));
  if (!configured) throw new AppError(502,
    'The LLM selected a workflow or tool that is not configured for this agent',
    'QDRANT_UNIVERSAL_LLM_WORKFLOW_NOT_AUTHORIZED');
  const argumentsJson = String(action.argumentsJson || '{}');
  if (Buffer.byteLength(argumentsJson) > 32_768) throw new AppError(502,
    'The workflow action arguments exceed the permitted size',
    'QDRANT_UNIVERSAL_LLM_WORKFLOW_ARGUMENTS_INVALID');
  let argumentsValue;
  try { argumentsValue = JSON.parse(argumentsJson); } catch {
    throw new AppError(502, 'The workflow action arguments are not valid JSON',
      'QDRANT_UNIVERSAL_LLM_WORKFLOW_ARGUMENTS_INVALID');
  }
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new AppError(502, 'The workflow action arguments must be an object',
      'QDRANT_UNIVERSAL_LLM_WORKFLOW_ARGUMENTS_INVALID');
  }
  return Object.freeze({ action: action.action, workflowId, toolName,
    arguments: Object.freeze(argumentsValue),
    authorizationQuote: cleanText(action.authorizationQuote, 2_000) });
}

function acceptDecision(raw, chunks, maximumSpeechCharacters, workflowDefinitions, context) {
  if (!raw || !outcomes.includes(raw.outcome)) {
    throw new AppError(502, 'Universal conversation LLM returned an invalid result',
      'QDRANT_UNIVERSAL_LLM_SCHEMA_INVALID');
  }
  const speech = boundedSpeech(raw.speech, maximumSpeechCharacters);
  if (!speech) throw new AppError(502, 'Universal conversation LLM returned empty speech',
    'QDRANT_UNIVERSAL_LLM_EMPTY');
  const evidenceIds = raw.outcome === 'FACTUAL_ANSWER'
    ? chunks.map(({ id }) => id) : [];
  const workflowAction = validatedWorkflowAction(raw, raw.outcome, workflowDefinitions);
  if (workflowAction?.action === 'EXECUTE') assertExplicitAction({
    intent: 'execute', utteranceComplete: true, unambiguous: true,
    quote: workflowAction.authorizationQuote,
  }, 'execute', context);
  return Object.freeze({ outcome: raw.outcome, speech,
    evidenceIds: Object.freeze(evidenceIds), workflowAction });
}

function universalPrompt({ agentPrompt, language, chunks, liveData, previousContext,
  maximumSpeechCharacters, workflowDefinitions, workflowState, conversationContext }) {
  const latestAssistantDelivery = ['interrupted', 'incomplete']
    .includes(conversationContext?.lastAssistantResponse?.completion)
    ? conversationContext.lastAssistantResponse : null;
  const compactTurnContext = Object.freeze({
    recentConversation: conversationContext?.recentConversation
      ?? previousContext ?? Object.freeze([]),
    pendingQuestion: conversationContext?.pendingQuestion ?? null,
    currentSpeech: conversationContext?.currentSpeech ?? Object.freeze({}),
    latestAssistantDelivery,
  });
  return [
    cleanText(agentPrompt, 24_000),
    'Generate one natural spoken response using the configured agent prompt, current question, recent conversation, retrieved context and workflow state.',
    'Choose FACTUAL_ANSWER, CONVERSATIONAL_RESPONSE, CLARIFICATION, UNAVAILABLE, WORKFLOW_ACTION, WORKFLOW_CANCELLATION or CLOSING.',
    'Use WORKFLOW_ACTION only for a supplied workflow. Use UPSERT to collect or correct fields. Use EXECUTE only after the completely delivered confirmation and explicit caller confirmation.',
    'For WORKFLOW_ACTION, return the configured workflowId and toolName, newly supplied arguments as argumentsJson, and the exact current-caller authorization phrase as authorizationQuote for EXECUTE; otherwise use an empty authorizationQuote.',
    'Do not use configured technical recovery text during an ordinary conversation.',
    'Live Data is the current source of truth for its tables. Use its current rows for prices, availability, counts and filters; do not use older conversation statements for those facts. Use rowCount as the exact full-table count. If a table says truncated, do not invent an exact filtered count from its partial rows.',
    `Caller language: ${cleanText(language, 80) || 'Follow the caller language'}`,
    ...(Number(maximumSpeechCharacters) > 0
      ? [`Maximum spoken characters: ${Math.floor(Number(maximumSpeechCharacters))}`]
      : ['No spoken character limit is configured for this agent.']),
    '<turn_context>', JSON.stringify(compactTurnContext),
    '</turn_context>', '<workflow_definitions>', JSON.stringify(workflowDefinitions),
    '</workflow_definitions>', '<current_workflow_state>', JSON.stringify(serializableObject(workflowState)),
    '</current_workflow_state>', '<retrieved_chunks>',
    JSON.stringify(chunks.map((chunk) => ({ id: chunk.id, filename: chunk.source.filename,
      chunkIndex: chunk.source.chunkIndex, text: chunk.text }))),
    '</retrieved_chunks>',
    '<current_live_data>', JSON.stringify(liveData ?? []), '</current_live_data>',
    'Return only the required JSON object. workflowAction must be null for every outcome except WORKFLOW_ACTION.',
  ].filter(Boolean).join('\n');
}

function legacyDecision(validated) {
  const decision = validated.outcome === 'CLARIFICATION' ? 'CLARIFY'
    : (validated.outcome === 'UNAVAILABLE' ? 'NO_MATCH' : 'RESPONSE');
  return Object.freeze({
    decision, outcome: validated.outcome,
    response: decision === 'CLARIFY' ? '' : validated.speech,
    clarification: decision === 'CLARIFY'
      ? Object.freeze({ reason: 'natural_contextual_clarification', question: validated.speech,
        candidates: Object.freeze([]) }) : null,
    search: null, tool: validated.workflowAction, nextQuestion: null, stateUpdate: null,
    evidenceIds: validated.evidenceIds,
  });
}

export async function runAgentQdrantUniversalTurn(input = {}, overrides = {}) {
  const invokeStructuredLlm = overrides.invokeStructuredLlm;
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('Qdrant universal turn requires one structured LLM invoker');
  }
  const retrieval = input.retrieval ?? await (overrides.retrieveKnowledge
    ?? retrieveAgentQdrantKnowledge)({
    tenantId: input.tenantId, agentId: input.agentId, question: input.currentQuestion,
    previousContext: input.previousContext, cancellationSignal: input.cancellationSignal,
  }, overrides.retrievalDependencies);
  const workflowDefinitions = Object.freeze(Array.isArray(input.workflowDefinitions)
    ? input.workflowDefinitions : []);
  const request = tagTemplateEngineTiming(Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: 'system', content: universalPrompt({
        agentPrompt: input.agentPrompt, language: input.language, chunks: retrieval.chunks,
        liveData: retrieval.liveData,
        previousContext: retrieval.request.previousContext,
        maximumSpeechCharacters: input.maximumSpeechCharacters, workflowDefinitions,
        workflowState: input.workflowState,
        conversationContext: input.conversationContext,
      }) }),
      Object.freeze({ role: 'user', content: cleanText(input.currentQuestion, 2_000) }),
    ]),
    temperature: 0,
    maxOutputTokens: llmTokenBudgetForSpeech(input.maximumSpeechCharacters),
    responseFormat: Object.freeze({ type: 'json_schema', name: 'agent_qdrant_universal_turn',
      strict: true, schema: universalTurnSchema }),
  }), 'answer_generation');
  const completion = await invokeStructuredLlm(request, {
    onSpeechSentence: input.onSpeechSentence,
    cancellationSignal: input.cancellationSignal,
  });
  const validated = acceptDecision(completionValue(completion), retrieval.chunks,
    input.maximumSpeechCharacters, workflowDefinitions, input.conversationContext);
  const evidence = Object.freeze(retrieval.chunks.map((chunk) => evidenceRecord(
    chunk, retrieval.request.tenantId, retrieval.request.agentId,
  )));
  return Object.freeze({
    decision: legacyDecision(validated), outcome: validated.outcome,
    workflowAction: validated.workflowAction, speech: validated.speech, evidence,
    liveData: retrieval.liveData,
    evidenceIds: validated.evidenceIds, retrievalDiagnostics: retrieval.diagnostics,
    speechStreaming: completion?.speechStreaming ?? null,
    llmInvocationCount: 1,
  });
}
