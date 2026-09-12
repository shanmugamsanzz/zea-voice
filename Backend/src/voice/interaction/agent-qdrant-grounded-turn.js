import { AppError } from '../../middleware/errors.js';
import { retrieveAgentQdrantKnowledge } from './agent-qdrant-retrieval.js';
import { tagTemplateEngineTiming } from './template-engine-turn-timing.js';

const outcomes = Object.freeze([
  'FACTUAL_ANSWER', 'CONVERSATIONAL_RESPONSE', 'CLARIFICATION', 'UNAVAILABLE',
  'WORKFLOW_ACTION', 'WORKFLOW_CANCELLATION', 'CLOSING',
]);

const universalTurnSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['outcome', 'speech', 'evidenceIds', 'workflowAction'],
  properties: Object.freeze({
    outcome: Object.freeze({ type: 'string', enum: outcomes }),
    speech: Object.freeze({ type: 'string' }),
    evidenceIds: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
    workflowAction: Object.freeze({
      type: ['object', 'null'], additionalProperties: false,
      required: ['action', 'workflowId', 'toolName', 'argumentsJson'],
      properties: Object.freeze({
        action: Object.freeze({ type: 'string', enum: Object.freeze(['UPSERT', 'EXECUTE']) }),
        workflowId: Object.freeze({ type: 'string' }),
        toolName: Object.freeze({ type: 'string' }),
        argumentsJson: Object.freeze({ type: 'string' }),
      }),
    }),
  }),
});

export const AGENT_QDRANT_GROUNDED_TURN_VERSION = 2;

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

function numericTokens(value) {
  return new Set(cleanText(value, 20_000).match(/[+-]?\p{N}+(?:[.,]\p{N}+)?/gu) ?? []);
}

function boundedSpeech(value, maximumCharacters) {
  const maximum = Math.max(80, Number(maximumCharacters) || 4_000);
  const speech = cleanText(value, Math.max(200, maximum));
  if (speech.length <= maximum) return speech;
  const prefix = speech.slice(0, maximum);
  const boundary = Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('?'), prefix.lastIndexOf('!'));
  return cleanText(boundary >= Math.floor(maximum * 0.45) ? prefix.slice(0, boundary + 1) : prefix);
}

function evidenceRecord(chunk, tenantId, agentId) {
  return Object.freeze({
    evidenceId: chunk.id, recordId: chunk.source.documentId, recordType: 'KNOWLEDGE_CHUNK',
    canonicalName: chunk.source.filename, content: chunk.text,
    authoritativeData: Object.freeze({ text: chunk.text }), tenantId, agentId,
    documentId: chunk.source.documentId, documentName: chunk.source.filename,
    documentDisplayName: chunk.source.filename,
    sourceSection: `Chunk ${chunk.source.chunkIndex + 1}`, verified: true,
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
    arguments: Object.freeze(argumentsValue) });
}

function validateDecision(raw, chunks, maximumSpeechCharacters, workflowDefinitions) {
  if (!raw || !outcomes.includes(raw.outcome) || !Array.isArray(raw.evidenceIds)) {
    throw new AppError(502, 'Universal conversation LLM returned an invalid result',
      'QDRANT_UNIVERSAL_LLM_SCHEMA_INVALID');
  }
  const speech = boundedSpeech(raw.speech, maximumSpeechCharacters);
  if (!speech) throw new AppError(502, 'Universal conversation LLM returned empty speech',
    'QDRANT_UNIVERSAL_LLM_EMPTY');
  const allowed = new Set(chunks.map(({ id }) => id));
  const evidenceIds = [...new Set(raw.evidenceIds.map((id) => cleanText(id, 240)).filter(Boolean))];
  if (evidenceIds.some((id) => !allowed.has(id))) throw new AppError(502,
    'Universal conversation LLM cited an unknown chunk', 'QDRANT_UNIVERSAL_LLM_CITATION_INVALID');
  if (raw.outcome === 'FACTUAL_ANSWER' && (!chunks.length || !evidenceIds.length)) {
    throw new AppError(502, 'A factual answer requires retrieved evidence',
      'QDRANT_UNIVERSAL_LLM_EVIDENCE_REQUIRED');
  }
  if (raw.outcome !== 'FACTUAL_ANSWER' && evidenceIds.length) throw new AppError(502,
    'Only a factual answer may cite knowledge chunks', 'QDRANT_UNIVERSAL_LLM_CITATION_INVALID');
  const cited = chunks.filter(({ id }) => evidenceIds.includes(id));
  const allowedNumbers = numericTokens(cited.map(({ text }) => text).join(' '));
  if (raw.outcome === 'FACTUAL_ANSWER'
    && [...numericTokens(speech)].some((number) => !allowedNumbers.has(number))) {
    throw new AppError(502, 'Universal conversation LLM introduced an unsupported number',
      'QDRANT_UNIVERSAL_LLM_NUMBER_INVALID');
  }
  return Object.freeze({ outcome: raw.outcome, speech,
    evidenceIds: Object.freeze(evidenceIds),
    workflowAction: validatedWorkflowAction(raw, raw.outcome, workflowDefinitions) });
}

function universalPrompt({ agentPrompt, agentConfiguration, request, language, chunks,
  maximumSpeechCharacters, workflowDefinitions, workflowState }) {
  return [
    cleanText(agentPrompt, 24_000),
    'You are the single decision and response operation for this live voice turn.',
    'Follow only the supplied agent configuration. Do not assume an identity, business, workflow, trigger, field question, confirmation, closing rule, recovery message, or tool permission that is not configured.',
    'Use retrieved chunks as the only source of business facts. Conversation context may resolve meaning but is not factual evidence.',
    'Return FACTUAL_ANSWER with supporting chunk IDs when the chunks answer the question.',
    'Return CONVERSATIONAL_RESPONSE for a natural non-factual response that follows the configured identity and conversation instructions.',
    'Return CLARIFICATION with one natural question only when the request is genuinely ambiguous.',
    'Return UNAVAILABLE naturally when requested business information is unsupported. Do not invent a negative policy or capability.',
    'For a configured workflow, return WORKFLOW_ACTION. Use UPSERT to start or collect/correct fields; use EXECUTE only when all required fields are present and the caller explicitly confirms while confirmation is pending.',
    'For WORKFLOW_ACTION, select exactly one supplied workflowId and toolName and put only newly supplied or corrected arguments in argumentsJson. Ask the configured next field question or configured confirmation in speech. For EXECUTE, use neutral speech that does not claim tool success.',
    'Return WORKFLOW_CANCELLATION only for cancellation of the active configured workflow. Return CLOSING only when the configured closing behavior and conversation justify ending the call.',
    'Static recovery messages in configuration are reserved for provider or system failure; never use them for an ordinary no-match or ambiguous turn.',
    `Caller language: ${cleanText(language, 80) || 'Follow the caller language'}`,
    `Maximum spoken characters: ${Number(maximumSpeechCharacters) || 4000}`,
    '<agent_configuration>', JSON.stringify(serializableObject(agentConfiguration)),
    '</agent_configuration>', '<conversation_context>', JSON.stringify(request.previousContext),
    '</conversation_context>', '<workflow_definitions>', JSON.stringify(workflowDefinitions),
    '</workflow_definitions>', '<current_workflow_state>', JSON.stringify(serializableObject(workflowState)),
    '</current_workflow_state>', '<retrieved_chunks>',
    JSON.stringify(chunks.map((chunk) => ({ id: chunk.id, filename: chunk.source.filename,
      chunkIndex: chunk.source.chunkIndex, text: chunk.text }))),
    '</retrieved_chunks>',
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
        agentPrompt: input.agentPrompt, agentConfiguration: input.agentConfiguration,
        request: retrieval.request, language: input.language, chunks: retrieval.chunks,
        maximumSpeechCharacters: input.maximumSpeechCharacters, workflowDefinitions,
        workflowState: input.workflowState,
      }) }),
      Object.freeze({ role: 'user', content: cleanText(input.currentQuestion, 2_000) }),
    ]),
    temperature: 0,
    responseFormat: Object.freeze({ type: 'json_schema', name: 'agent_qdrant_universal_turn',
      strict: true, schema: universalTurnSchema }),
  }), 'answer_generation');
  const completion = await invokeStructuredLlm(request);
  const validated = validateDecision(completionValue(completion), retrieval.chunks,
    input.maximumSpeechCharacters, workflowDefinitions);
  const evidence = Object.freeze(retrieval.chunks.map((chunk) => evidenceRecord(
    chunk, retrieval.request.tenantId, retrieval.request.agentId,
  )));
  return Object.freeze({
    decision: legacyDecision(validated), outcome: validated.outcome,
    workflowAction: validated.workflowAction, speech: validated.speech, evidence,
    evidenceIds: validated.evidenceIds, retrievalDiagnostics: retrieval.diagnostics,
    llmInvocationCount: 1,
  });
}
