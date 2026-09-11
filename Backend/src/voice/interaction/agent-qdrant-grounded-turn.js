import { AppError } from '../../middleware/errors.js';
import { retrieveAgentQdrantKnowledge } from './agent-qdrant-retrieval.js';
import { tagTemplateEngineTiming } from './template-engine-turn-timing.js';

const groundedDocumentAnswerSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'speech', 'evidenceIds'],
  properties: Object.freeze({
    decision: Object.freeze({ type: 'string', enum: Object.freeze(['RESPONSE', 'CLARIFY', 'NO_MATCH']) }),
    speech: Object.freeze({ type: 'string' }),
    evidenceIds: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
  }),
});

export const AGENT_QDRANT_GROUNDED_TURN_VERSION = 1;

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
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
  const speech = cleanText(value, Math.max(200, Number(maximumCharacters) || 4_000));
  const maximum = Math.max(80, Number(maximumCharacters) || 4_000);
  if (speech.length <= maximum) return speech;
  const prefix = speech.slice(0, maximum);
  const boundary = Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('?'), prefix.lastIndexOf('!'));
  return cleanText(boundary >= Math.floor(maximum * 0.45) ? prefix.slice(0, boundary + 1) : prefix);
}

function evidenceRecord(chunk, tenantId, agentId) {
  return Object.freeze({
    evidenceId: chunk.id,
    recordId: chunk.source.documentId,
    recordType: 'KNOWLEDGE_CHUNK',
    canonicalName: chunk.source.filename,
    content: chunk.text,
    authoritativeData: Object.freeze({ text: chunk.text }),
    tenantId,
    agentId,
    documentId: chunk.source.documentId,
    documentName: chunk.source.filename,
    documentDisplayName: chunk.source.filename,
    sourceSection: `Chunk ${chunk.source.chunkIndex + 1}`,
    verified: true,
    callerFacing: true,
    source: chunk.source,
    score: chunk.score,
  });
}

function validateDecision(raw, chunks, maximumSpeechCharacters) {
  if (!raw || !['RESPONSE', 'CLARIFY', 'NO_MATCH'].includes(raw.decision)
    || !Array.isArray(raw.evidenceIds)) {
    throw new AppError(502, 'Grounded document LLM returned an invalid decision',
      'QDRANT_GROUNDED_LLM_SCHEMA_INVALID');
  }
  const speech = boundedSpeech(raw.speech, maximumSpeechCharacters);
  if (!speech) throw new AppError(502, 'Grounded document LLM returned empty speech',
    'QDRANT_GROUNDED_LLM_EMPTY');
  const allowed = new Set(chunks.map(({ id }) => id));
  const evidenceIds = [...new Set(raw.evidenceIds.map((id) => cleanText(id, 240)).filter(Boolean))];
  if (evidenceIds.some((id) => !allowed.has(id))) {
    throw new AppError(502, 'Grounded document LLM cited an unknown chunk',
      'QDRANT_GROUNDED_LLM_CITATION_INVALID');
  }
  if (raw.decision === 'RESPONSE' && (!chunks.length || !evidenceIds.length)) {
    throw new AppError(502, 'A factual response requires retrieved evidence',
      'QDRANT_GROUNDED_LLM_EVIDENCE_REQUIRED');
  }
  if (raw.decision !== 'RESPONSE' && evidenceIds.length) {
    throw new AppError(502, 'Clarification and unavailable responses cannot cite facts',
      'QDRANT_GROUNDED_LLM_CITATION_INVALID');
  }
  const cited = chunks.filter(({ id }) => evidenceIds.includes(id));
  const allowedNumbers = numericTokens(cited.map(({ text }) => text).join(' '));
  if (raw.decision === 'RESPONSE'
    && [...numericTokens(speech)].some((number) => !allowedNumbers.has(number))) {
    throw new AppError(502, 'Grounded document LLM introduced an unsupported number',
      'QDRANT_GROUNDED_LLM_NUMBER_INVALID');
  }
  return Object.freeze({ decision: raw.decision, speech, evidenceIds: Object.freeze(evidenceIds) });
}

function groundedPrompt({ agentPrompt, request, language, chunks, maximumSpeechCharacters }) {
  return [
    cleanText(agentPrompt, 24_000),
    'You are producing the single final response for a live voice conversation.',
    'Use retrieved chunks as the only source of business facts. Conversation context may resolve meaning but is not factual evidence.',
    'If the chunks answer the current question, return RESPONSE and cite only supporting chunk IDs.',
    'If the request is genuinely ambiguous, return CLARIFY with one natural question and no evidence IDs.',
    'If the requested information is not supported, return NO_MATCH with a natural safe response in the caller language and no evidence IDs. Do not invent a negative policy or capability.',
    `Caller language: ${cleanText(language, 80) || 'Follow the caller language'}`,
    `Maximum spoken characters: ${Number(maximumSpeechCharacters) || 4000}`,
    '<conversation_context>',
    JSON.stringify(request.previousContext),
    '</conversation_context>',
    '<retrieved_chunks>',
    JSON.stringify(chunks.map((chunk) => ({
      id: chunk.id,
      filename: chunk.source.filename,
      chunkIndex: chunk.source.chunkIndex,
      text: chunk.text,
    }))),
    '</retrieved_chunks>',
    'Return only the required JSON object.',
  ].filter(Boolean).join('\n');
}

export async function runAgentQdrantGroundedTurn(input = {}, overrides = {}) {
  const invokeStructuredLlm = overrides.invokeStructuredLlm;
  if (typeof invokeStructuredLlm !== 'function') {
    throw new TypeError('Qdrant grounded turn requires one structured LLM invoker');
  }
  const retrieval = input.retrieval ?? await (
    overrides.retrieveKnowledge ?? retrieveAgentQdrantKnowledge
  )({
    tenantId: input.tenantId,
    agentId: input.agentId,
    question: input.currentQuestion,
    previousContext: input.previousContext,
    cancellationSignal: input.cancellationSignal,
  }, overrides.retrievalDependencies);
  const request = tagTemplateEngineTiming(Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: 'system', content: groundedPrompt({
        agentPrompt: input.agentPrompt,
        request: retrieval.request,
        language: input.language,
        chunks: retrieval.chunks,
        maximumSpeechCharacters: input.maximumSpeechCharacters,
      }) }),
      Object.freeze({ role: 'user', content: cleanText(input.currentQuestion, 2_000) }),
    ]),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema',
      name: 'agent_qdrant_grounded_answer',
      strict: true,
      schema: groundedDocumentAnswerSchema,
    }),
  }), 'answer_generation');
  const completion = await invokeStructuredLlm(request);
  const validated = validateDecision(
    completionValue(completion), retrieval.chunks, input.maximumSpeechCharacters,
  );
  const evidence = Object.freeze(retrieval.chunks.map((chunk) => evidenceRecord(
    chunk, retrieval.request.tenantId, retrieval.request.agentId,
  )));
  return Object.freeze({
    decision: Object.freeze({
      decision: validated.decision,
      response: validated.decision === 'CLARIFY' ? '' : validated.speech,
      clarification: validated.decision === 'CLARIFY'
        ? Object.freeze({ reason: 'natural_contextual_clarification', question: validated.speech,
          candidates: Object.freeze([]) }) : null,
      search: null,
      tool: null,
      nextQuestion: null,
      stateUpdate: null,
      evidenceIds: validated.evidenceIds,
    }),
    speech: validated.speech,
    evidence,
    evidenceIds: validated.evidenceIds,
    retrievalDiagnostics: retrieval.diagnostics,
    llmInvocationCount: 1,
  });
}
