import { AppError } from '../../middleware/errors.js';
import { instrumentTemplateEngineTurn } from './template-engine-turn-timing.js';
import { normalizedSpeechBudget, speechBudgetInstruction } from './template-engine-speech-budget.js';
import { applyMinimalTemplateEngineStateUpdate, createMinimalTemplateEngineState } from './template-engine-state.js';
import { loadTemplateEngineWorkflowContext } from './template-engine-workflow-context.js';
import { advanceTemplateEngineWorkflowTurn, templateEngineWorkflowRoutingContext } from './template-engine-workflow-runtime.js';
import {
  assignedToolIdentifiers,
  configuredWorkflowToolIdentifier,
} from '../../knowledge-bases/workflow-tool-authorization.js';
import { selectApplicableConversationGuidance, welcomeContinuationContext } from './template-engine-conversation-guidance.js';
import { extractSchemaFieldValue } from './schema-field-value-extractor.js';
import { acknowledgementOnly } from '../interruption/final-turn-validator.js';
import { validateAndComposeTemplateEngineSpeech } from './template-engine-speech-composer.js';
import { retrieveAgentQdrantKnowledge } from './agent-qdrant-retrieval.js';
import { runAgentQdrantGroundedTurn } from './agent-qdrant-grounded-turn.js';

export const TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION = 4;

export function createSingleLlmTurnInvoker(invoke, onInvocation = null) {
  if (typeof invoke !== 'function') throw new TypeError('Single-LLM turn requires an invoker');
  let invocationCount = 0;
  return Object.freeze({
    invoke: async (request) => {
      if (request?.responseFormat?.type !== 'json_schema'
        || !cleanText(request?.responseFormat?.name, 160)) {
        throw new AppError(500, 'Template-engine LLM operation must use a structured schema',
          'TEMPLATE_ENGINE_LLM_OPERATION_NOT_STRUCTURED');
      }
      if (invocationCount >= 1) {
        throw new AppError(500, 'Template-engine turn attempted more than one LLM invocation',
          'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED', {
            maximumInvocations: 1,
            attemptedOperation: request?.responseFormat?.name ?? null,
          });
      }
      invocationCount += 1;
      onInvocation?.(Object.freeze({ invocationCount,
        operation: request?.responseFormat?.name ?? null }));
      return invoke(request);
    },
    count: () => invocationCount,
  });
}

export function assertSingleLlmTurnArchitecture({
  invocationCount, requireExactlyOne = false, turnKind = 'deterministic',
} = {}) {
  const count = Number(invocationCount);
  if (!Number.isInteger(count) || count < 0 || count > 1) {
    throw new AppError(500, 'Template-engine turn exceeded the one-LLM architecture',
      'TEMPLATE_ENGINE_LLM_INVOCATION_LIMIT_EXCEEDED', {
        invocationCount: Number.isFinite(count) ? count : null,
        maximumInvocations: 1,
        turnKind,
      });
  }
  if (requireExactlyOne && count !== 1) {
    throw new AppError(500, 'Factual template-engine turn did not use exactly one LLM call',
      'TEMPLATE_ENGINE_ARCHITECTURE_VIOLATION', {
        invocationCount: count,
        requiredInvocations: 1,
        turnKind,
      });
  }
  return Object.freeze({
    enforced: true,
    invocationCount: count,
    maximumInvocations: 1,
    exactlyOneRequired: requireExactlyOne,
    turnKind,
  });
}

export function assertQdrantFactualRetrievalArchitecture(diagnostics = {}) {
  const queryEmbeddingCount = Number(diagnostics.queryEmbeddingCount);
  const qdrantSearchCount = Number(diagnostics.qdrantSearchCount);
  const returnedChunkCount = Number(diagnostics.returnedChunkCount);
  const maximumChunks = Number(diagnostics.maximumChunks);
  const violations = [];
  if (queryEmbeddingCount !== 1) violations.push('query_embedding_must_run_once');
  if (qdrantSearchCount !== 1) violations.push('qdrant_search_must_run_once');
  if (!Number.isInteger(returnedChunkCount) || returnedChunkCount < 0
    || returnedChunkCount > 3) violations.push('qdrant_must_return_at_most_three_chunks');
  if (maximumChunks !== 3) violations.push('qdrant_maximum_chunks_must_be_three');
  if (diagnostics.tenantAgentFiltered !== true) {
    violations.push('qdrant_search_must_be_tenant_agent_filtered');
  }
  if (violations.length) {
    throw new AppError(500, 'Factual retrieval violated the Qdrant architecture',
      'TEMPLATE_ENGINE_RETRIEVAL_ARCHITECTURE_VIOLATION', {
        violations: Object.freeze(violations),
        queryEmbeddingCount,
        qdrantSearchCount,
        returnedChunkCount,
        maximumChunks,
        tenantAgentFiltered: diagnostics.tenantAgentFiltered === true,
      });
  }
  return Object.freeze({
    enforced: true,
    queryEmbeddingCount,
    qdrantSearchCount,
    returnedChunkCount,
    maximumChunks,
    tenantAgentFiltered: true,
  });
}

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const conversationalAcknowledgementTokens = new Set([
  'ok', 'okay', 'yes', 'sure', 'continue', 'go', 'ahead', 'please', 'madam', 'sir',
  'சரி', 'ஆம்', 'ஆமா', 'ஆமாம்', 'சொல்லுங்க', 'சொல்லு', 'ம்', 'ம்ம்', 'ஆ',
  'சரி', 'ஆம்', 'ஆமா', 'ஆமாம்', 'சொல்லுங்க', 'சொல்லு', 'ம்', 'ம்ம்', 'ஆ',
  'seri', 'sari', 'aama', 'aamam', 'sollunga', 'sollu', 'madam', 'sir',
]);

function deterministicAcknowledgementOnly(value, configuredPhrases = []) {
  if (acknowledgementOnly(value, configuredPhrases)) return true;
  const tokens = cleanText(value, 300).toLocaleLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/gu).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 4
    && tokens.every((token) => conversationalAcknowledgementTokens.has(token));
}

export function deterministicWelcomeContinuation({
  latestUtterance, welcomeContinuation, acknowledgementPhrases = [],
} = {}) {
  const candidates = Array.isArray(welcomeContinuation?.candidates)
    ? welcomeContinuation.candidates : [];
  const utteranceTokens = cleanText(latestUtterance, 300).toLocaleLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/gu).filter(Boolean);
  const configuredTokens = new Set(acknowledgementPhrases.flatMap((phrase) => (
    cleanText(phrase, 100).toLocaleLowerCase()
      .split(/[^\p{L}\p{M}\p{N}]+/gu).filter(Boolean)
  )));
  const acknowledgement = deterministicAcknowledgementOnly(latestUtterance, acknowledgementPhrases)
    || (utteranceTokens.length > 0 && utteranceTokens.length <= 4
      && utteranceTokens.every((token) => configuredTokens.has(token)
        || ['yes', 'okay', 'ok', 'sure', 'madam', 'sir'].includes(token))
      && utteranceTokens.some((token) => configuredTokens.has(token)
        || ['yes', 'okay', 'ok', 'sure'].includes(token)));
  if (!acknowledgement
    || candidates.length !== 1) return null;
  const selected = candidates[0];
  const query = cleanText([
    ...(Array.isArray(selected.catalogReferences) ? selected.catalogReferences : []),
    selected.content, selected.purpose,
  ].filter(Boolean).join(' '));
  const requestedFact = cleanText(selected.intentClass ?? selected.purpose, 500);
  if (!selected.recordId || !query || !requestedFact) return null;
  return Object.freeze({
    kind: 'published_welcome_continuation',
    originalUtterance: cleanText(latestUtterance),
    pendingWelcomeQuestion: welcomeContinuation.pendingQuestion ?? null,
    publishedNextStep: selected, query, requestedFact,
  });
}

function evidenceIds(decision) {
  return Array.isArray(decision?.evidenceIds) ? decision.evidenceIds : [];
}

function numericTokens(value) {
  return new Set(cleanText(value).match(/[+-]?\p{N}+(?:[.,]\p{N}+)?/gu) ?? []);
}

function followUpClaimsSupported(decision, evidence) {
  const question = cleanText(decision?.nextQuestion?.question);
  if (!question) return true;
  const cited = new Set(evidenceIds(decision));
  const selectedEvidence = evidence.filter((record) => cited.has(record.evidenceId));
  const allowedNumbers = numericTokens(selectedEvidence.map((record) => [
    record?.content, JSON.stringify(record?.authoritativeData ?? {}),
  ].join(' ')).join(' '));
  return [...numericTokens(question)].every((number) => allowedNumbers.has(number));
}

function conversationStage(state, decision = null) {
  if (state?.activeWorkflowId) {
    return `workflow ${cleanText(state.confirmationStatus, 80) || 'active'}`;
  }
  if (state?.pendingClarification) return 'pending clarification';
  return [decision?.decision, decision?.search?.requestedFact]
    .map((value) => cleanText(value, 160)).filter(Boolean).join(' ') || 'conversation';
}

function reportGuidanceSelection(callback, phase, guidance) {
  callback?.(Object.freeze({
    phase,
    selected: Boolean(guidance),
    recordId: guidance?.recordId ?? null,
    intentClass: guidance?.intentClass ?? null,
    nodeKey: guidance?.nodeKey ?? null,
    conversationStage: guidance?.conversationStage ?? null,
    hasNextQuestion: Boolean(cleanText(guidance?.nextQuestion)),
    selectionScore: guidance?.selectionScore ?? null,
    selectionReasons: guidance?.selectionReasons ?? Object.freeze([]),
  }));
}

function composeDeterministicSpeech({
  decision, recentCompleteTurns, conversationGuidance,
  evidence, suppressFollowUp = false,
  maximumSpeechCharacters = null,
  onDiagnostics,
}) {
  let claimsValidated = followUpClaimsSupported(decision, evidence);
  let composed = validateAndComposeTemplateEngineSpeech({
    decision, recentCompleteTurns, conversationGuidance, suppressFollowUp,
    claimsValidated, maximumSpeechCharacters,
  });
  if (maximumSpeechCharacters && composed.speech.length > maximumSpeechCharacters) {
    throw new AppError(502, 'The complete validated answer exceeds the speech budget',
      'TEMPLATE_ENGINE_SPEECH_BUDGET_EXCEEDED');
  }
  onDiagnostics?.(Object.freeze({
    guidanceRecordId: conversationGuidance?.recordId ?? null,
    guidanceHasNextQuestion: Boolean(cleanText(conversationGuidance?.nextQuestion)),
    proposed: Boolean(cleanText(decision?.nextQuestion?.question)),
    accepted: composed.followUp.accepted,
    validationReason: composed.followUp.reason,
  }));
  return composed;
}

function applyDecisionState(state, decision, evidence = [], {
  preservePendingClarification = false,
} = {}) {
  let next = state;
  if (decision?.stateUpdate) next = applyMinimalTemplateEngineStateUpdate(next, decision.stateUpdate);
  const citedEvidenceIds = evidenceIds(decision);
  const recordsByEvidenceId = new Map(evidence.map((record) => [
    record.evidenceId, record.recordId,
  ]));
  const citedRecordIds = citedEvidenceIds.map((id) => recordsByEvidenceId.get(id)).filter(Boolean);
  if (citedRecordIds.length) {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: { lastReferencedRecordIds: citedRecordIds }, clear: [],
    });
  }
  if (decision?.decision === 'CLARIFY') {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: { pendingClarification: decision.clarification }, clear: [],
    });
  } else if (next.pendingClarification && !preservePendingClarification) {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: {}, clear: ['pendingClarification'],
    });
  }
  return next;
}

function responseProvenance({
  initialDecision, finalDecision, evidenceIds: citedEvidenceIds = [], workflowId = null,
  toolId = null, validationResult = 'valid', searchPerformed = false,
  clarificationReason = null,
} = {}) {
  return Object.freeze({
    initialDecision,
    finalDecision,
    evidenceIds: Object.freeze([...new Set(citedEvidenceIds)]),
    workflowId,
    toolId,
    validationResult,
    searchPerformed,
    clarificationReason,
  });
}

function authorizedWorkflowSummaries(workflows, tools) {
  return workflows.flatMap((workflow) => {
    const identifier = configuredWorkflowToolIdentifier(workflow);
    const matches = tools.filter((tool) => assignedToolIdentifiers(tool).has(identifier));
    if (matches.length !== 1) return [];
    return [Object.freeze({
      workflowRecordId: workflow.recordId,
      toolName: matches[0].name,
      description: workflow.description ?? workflow.name ?? matches[0].description ?? null,
      requiredFields: matches[0].configuration?.inputSchema?.required
        ?? matches[0].inputSchema?.required ?? [],
    })];
  });
}

function callerVerifiedArguments(argumentsValue, utterance, recentTurns = [], existing = {}) {
  const callerContext = [
    ...(Array.isArray(recentTurns) ? recentTurns : []).filter((turn) => (
      turn?.role === 'user'
    )).map((turn) => turn.content),
    utterance,
  ].join(' ');
  const normalizedUtterance = cleanText(callerContext, 16_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}@+.:/-]+/gu, ' ');
  return Object.fromEntries(Object.entries(object(argumentsValue)).filter(([key, value]) => {
    if (Object.hasOwn(existing, key) && existing[key] === value) return true;
    const normalizedValue = cleanText(value, 1_000).toLocaleLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}@+.:/-]+/gu, ' ').trim();
    return normalizedValue && normalizedUtterance.includes(normalizedValue);
  }));
}

function deterministicConfiguredWorkflowMatch(utterance, workflows = []) {
  const request = scalarIdentity(utterance);
  if (!request) return null;
  const requestTokens = new Set(request.split(/\s+/u).filter((token) => token.length > 1));
  const matches = workflows.map((workflow) => {
    const configured = scalarIdentity([workflow.intent, workflow.name].filter(Boolean).join(' '));
    const tokens = configured.split(/\s+/u).filter((token) => token.length > 1);
    const overlap = tokens.filter((token) => requestTokens.has(token)).length;
    const exact = configured && (request.includes(configured) || configured.includes(request));
    return { workflow, score: exact ? 1 : tokens.length ? overlap / tokens.length : 0 };
  }).filter(({ score }) => score >= 0.8).sort((left, right) => right.score - left.score
    || Number(left.workflow.priority ?? 100) - Number(right.workflow.priority ?? 100));
  if (!matches.length || (matches[1] && matches[0].score === matches[1].score)) return null;
  return Object.freeze({ recordId: matches[0].workflow.recordId });
}

function deterministicWorkflowActivationDecision(match, workflows, tools) {
  if (!match?.recordId) return null;
  const workflow = workflows.find((candidate) => (
    cleanText(candidate?.recordId ?? candidate?.id, 160).toLocaleLowerCase()
      === cleanText(match.recordId, 160).toLocaleLowerCase()
  ));
  if (!workflow) return null;
  const identifier = configuredWorkflowToolIdentifier(workflow);
  const matches = tools.filter((tool) => assignedToolIdentifiers(tool).has(identifier));
  if (!identifier || matches.length !== 1) return null;
  return Object.freeze({
    decision: 'TOOL', response: '', clarification: null, search: null,
    tool: Object.freeze({ name: matches[0].name, arguments: Object.freeze({}) }),
    nextQuestion: null, stateUpdate: null,
  });
}

function deterministicContextualWorkflowActivationDecision({
  utterance, state, workflowSummaries = [],
} = {}) {
  if (state?.activeWorkflowId || workflowSummaries.length !== 1
    || !(state?.lastReferencedRecordIds ?? []).length) return null;
  const normalized = scalarIdentity(utterance);
  const action = /\b(?:perform|book|schedule|request|proceed|start|do)\b/iu.test(normalized)
    || /(?:புக்|பதிவு|செய்ய|ஆரம்பி)/u.test(normalized);
  const reference = /\b(?:it|this|that|one)\b/iu.test(normalized)
    || /(?:இதை|அதை|இதற்கு|அதற்கு)/u.test(normalized);
  if (!action || !reference) return null;
  return Object.freeze({
    decision: 'TOOL', response: '', clarification: null, search: null,
    tool: Object.freeze({
      name: workflowSummaries[0].toolName, arguments: Object.freeze({}),
    }),
    nextQuestion: null, stateUpdate: null,
  });
}

function deterministicUnresolvedSearchDecision(latestUtterance) {
  return Object.freeze({
    decision: 'SEARCH',
    response: '',
    clarification: null,
    search: Object.freeze({
      query: latestUtterance,
      requestedFact: latestUtterance,
      contextualReference: null,
      preferredRecordIds: Object.freeze([]),
    }),
    tool: null,
    nextQuestion: null,
    stateUpdate: null,
  });
}

const deterministicWorkflowFieldTypes = new Set([
  'number', 'integer', 'date', 'time', 'email', 'phone', 'string', 'text',
]);
const reviewedTextWorkflowFieldTypes = new Set(['string', 'text']);

function scalarIdentity(value) {
  return cleanText(value, 1_000).toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function tamilSpeech(value) {
  return /[\u0B80-\u0BFF]/u.test(cleanText(value, 1_000));
}

function phraseContained(utterance, phrases = []) {
  const value = ` ${scalarIdentity(utterance)} `;
  return phrases.some((phrase) => {
    const candidate = scalarIdentity(phrase);
    return candidate && value.includes(` ${candidate} `);
  });
}

function deterministicConversationControlDecision({
  utterance, explicitStopPhrases = [], state,
} = {}) {
  const text = cleanText(utterance, 1_000);
  const normalized = scalarIdentity(text);
  if (!normalized) return null;
  const tamil = tamilSpeech(text);
  const clearWorkflow = Object.freeze({
    set: Object.freeze({ confirmationStatus: null }),
    clear: Object.freeze(['activeWorkflowId', 'collectedToolFields', 'confirmationStatus']),
  });
  if (phraseContained(text, [
    'வேண்டாம்', 'நிறுத்து', 'ரத்து', 'கட் பண்ணு',
  ])) return Object.freeze({
    decision: 'RESPONSE', response: 'சரி, இந்த கோரிக்கையை நிறுத்திவிட்டேன்.',
    clarification: null, search: null, tool: null, nextQuestion: null,
    stateUpdate: state?.activeWorkflowId ? clearWorkflow : null,
  });
  if (phraseContained(text, [
    'அவ்வளவுதான்', 'வேற எதுவும் இல்லை', 'போதும்', 'நன்றி வணக்கம்',
  ])) return Object.freeze({
    decision: 'RESPONSE', response: 'நன்றி. வணக்கம்.',
    clarification: null, search: null, tool: null, nextQuestion: null,
    stateUpdate: state?.activeWorkflowId ? clearWorkflow : null,
  });
  if (phraseContained(text, [
    'புரியல', 'புரியவில்லை', 'தெளிவாக இல்லை',
  ])) return Object.freeze({
    decision: 'CLARIFY', response: '', search: null, tool: null,
    clarification: Object.freeze({
      reason: 'caller_did_not_understand',
      question: 'எந்த விஷயத்தை மீண்டும் விளக்க வேண்டும் என்று சொல்லுங்கள்.',
      candidates: Object.freeze([]),
    }),
    nextQuestion: null, stateUpdate: null,
  });
  const cancellation = phraseContained(text, [
    ...explicitStopPhrases, 'cancel', 'stop', 'cut', 'never mind', 'do not book',
    'வேண்டாம்', 'நிறுத்து', 'ரத்து', 'கட் பண்ணு',
  ]);
  if (cancellation) return Object.freeze({
    decision: 'RESPONSE',
    response: tamil ? 'சரி, இந்த கோரிக்கையை நிறுத்திவிட்டேன்.' : 'Okay, I have stopped this request.',
    clarification: null, search: null, tool: null, nextQuestion: null,
    stateUpdate: state?.activeWorkflowId ? clearWorkflow : null,
  });
  const closing = phraseContained(text, [
    'that is all', "that's all", 'nothing else', 'no more', 'goodbye', 'bye',
    'nandri vanakkam', 'avlothan', 'avvalavuthan', 'podhum',
    'அவ்வளவுதான்', 'வேற எதுவும் இல்லை', 'போதும்', 'நன்றி வணக்கம்',
  ]);
  if (closing) return Object.freeze({
    decision: 'RESPONSE',
    response: tamil ? 'நன்றி. வணக்கம்.' : 'Thank you. Goodbye.',
    clarification: null, search: null, tool: null, nextQuestion: null,
    stateUpdate: state?.activeWorkflowId ? clearWorkflow : null,
  });
  const misunderstanding = phraseContained(text, [
    'do not understand', "don't understand", 'did not understand', 'not clear',
    'புரியல', 'புரியவில்லை', 'தெளிவாக இல்லை',
  ]);
  if (misunderstanding) return Object.freeze({
    decision: 'CLARIFY', response: '', search: null, tool: null,
    clarification: Object.freeze({
      reason: 'caller_did_not_understand',
      question: tamil ? 'எந்த விஷயத்தை மீண்டும் விளக்க வேண்டும் என்று சொல்லுங்க.'
        : 'Please tell me which part you would like me to explain again.',
      candidates: Object.freeze([]),
    }),
    nextQuestion: null, stateUpdate: null,
  });
  return null;
}

export function deterministicIdentityQuestionDecision({ utterance, runtimeProfile } = {}) {
  const text = cleanText(utterance, 1_000);
  const normalized = scalarIdentity(text);
  const actualTamilOrigin = /(?:எங்கிருந்து\s+பேசு|எங்க\s+இருந்து\s+பேசு|எந்த\s+(?:ஹாஸ்பிடல்|மருத்துவமனை|கம்பெனி)|என்ன\s+(?:ஹாஸ்பிடல்|மருத்துவமனை|கம்பெனி))/u
    .test(normalized);
  const actualTamilIdentity = /(?:யார்\s+பேசு|நீங்க\s+யாரு|உங்க\s+பெயர்\s+என்ன)/u
    .test(normalized);
  if (actualTamilOrigin || actualTamilIdentity) {
    const configuredIdentity = cleanText(
      runtimeProfile?.agent?.name ?? runtimeProfile?.agent?.description, 500,
    );
    if (!configuredIdentity) return null;
    return Object.freeze({
      decision: 'RESPONSE',
      response: actualTamilOrigin
        ? `நான் ${configuredIdentity} சார்பாக பேசுகிறேன்.` : `நான் ${configuredIdentity}.`,
      clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
    });
  }
  const asksOrigin = /\b(?:where are you (?:calling|speaking) from|which (?:company|organisation|organization)|what (?:company|organisation|organization))\b/iu
    .test(normalized)
    || /(?:எங்கிருந்து\s+பேசு|எங்க\s+இருந்து\s+பேசு|எந்த\s+(?:ஹாஸ்பிடல்|மருத்துவமனை|கம்பெனி)|என்ன\s+(?:ஹாஸ்பிடல்|மருத்துவமனை|கம்பெனி))/u.test(normalized);
  const asksIdentity = /\b(?:who are you|who is (?:calling|speaking)|what is your name)\b/iu.test(normalized)
    || /(?:யார்\s+பேசு|நீங்க\s+யாரு|உங்க\s+பெயர்\s+என்ன)/u.test(normalized);
  if (!asksOrigin && !asksIdentity) return null;
  const agentName = cleanText(runtimeProfile?.agent?.name, 240);
  const description = cleanText(runtimeProfile?.agent?.description, 500);
  const identity = agentName || description;
  if (!identity) return null;
  const response = tamilSpeech(text)
    ? asksOrigin ? `நான் ${identity} சார்பாக பேசுகிறேன்.` : `நான் ${identity}.`
    : asksOrigin ? `I am calling on behalf of ${identity}.` : `I am ${identity}.`;
  return Object.freeze({
    decision: 'RESPONSE', response, clarification: null, search: null,
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function workflowFieldAliases(field) {
  const key = cleanText(field?.key, 80).replace(/[_-]+/gu, ' ');
  const label = cleanText(field?.label ?? field?.schema?.title, 120);
  const tail = key.split(/\s+/u).at(-1);
  return [...new Set([key, label, tail]
    .map(scalarIdentity).filter((value) => value.length >= 2))]
    .sort((left, right) => right.length - left.length);
}

export function deterministicWorkflowCorrectionDecision(context, utterance, state) {
  if (!context?.toolName || !state?.activeWorkflowId) return null;
  const text = cleanText(utterance, 1_000);
  const matchableText = text.replace(/[_-]+/gu, ' ');
  const normalized = scalarIdentity(text);
  const fields = context.fields ?? [];
  const aliases = fields.flatMap((field) => workflowFieldAliases(field));
  const correctionSignal = /\b(?:change|correct|correction|update|replace|set|wrong)\b/iu.test(text)
    || /(?:மாற்று|திருத்து|தப்பு|தவறு)/u.test(text);
  const readbackSignal = /\b(?:what|which|recorded|saved|captured|entered)\b/iu.test(normalized)
    || /(?:என்ன|எதை|பதிவு|சொன்ன)/u.test(normalized);
  const candidateValues = {};
  for (const field of fields) {
    const fieldAliases = workflowFieldAliases(field);
    const matchedAlias = fieldAliases.find((alias) => (
      ` ${normalized} `.includes(` ${alias} `)
    ));
    if (!matchedAlias) continue;
    const remainingAliases = aliases.filter((alias) => alias !== matchedAlias)
      .map(regexEscape).join('|');
    const pattern = new RegExp(
      `${regexEscape(matchedAlias)}\\s*(?:is|to|as|=|:|வந்து|என்பது)?\\s*` +
      `(.+?)${remainingAliases ? `(?=\\s+(?:${remainingAliases})\\s|$)` : '$'}`, 'iu',
    );
    const captured = pattern.exec(matchableText)?.[1]?.trim();
    if (!captured) continue;
    const value = extractSchemaFieldValue({
      ...field.schema, type: field.type ?? field.schema?.type,
      question: field.question, label: field.key,
    }, captured, { history: [{ role: 'assistant', content: field.question }], onlyMissing: true });
    if (value !== undefined) candidateValues[field.key] = value;
  }
  if (Object.keys(candidateValues).length && (correctionSignal
    || (context.awaitingConfirmation && !readbackSignal)
    || Object.keys(candidateValues).length > 1)) {
    return Object.freeze({
      decision: 'TOOL', response: '', clarification: null, search: null,
      tool: Object.freeze({ name: context.toolName, arguments: Object.freeze(candidateValues) }),
      nextQuestion: null, stateUpdate: null,
    });
  }
  if (correctionSignal && context.awaitingConfirmation) {
    const mentioned = fields.find((field) => workflowFieldAliases(field).some((alias) => (
      ` ${normalized} `.includes(` ${alias} `)
    )));
    if (mentioned) {
      const remaining = { ...object(state.collectedToolFields) };
      delete remaining[mentioned.key];
      return Object.freeze({
        decision: 'CLARIFY', response: '', search: null, tool: null,
        clarification: Object.freeze({
          reason: 'workflow_correction_value_required', question: mentioned.question,
          candidates: Object.freeze([]),
        }),
        nextQuestion: null,
        stateUpdate: Object.freeze({
          set: Object.freeze({ collectedToolFields: Object.freeze(remaining),
            confirmationStatus: 'pending_fields' }), clear: Object.freeze([]),
        }),
      });
    }
  }
  return null;
}

export function deterministicWorkflowReadbackDecision(context, utterance, state) {
  if (!context?.toolName || !state?.activeWorkflowId) return null;
  const normalized = scalarIdentity(utterance);
  const readbackSignal = /\b(?:what|which|recorded|saved|captured|entered)\b/iu.test(normalized)
    || /(?:என்ன|எதை|பதிவு|சொன்ன)/u.test(normalized);
  if (!readbackSignal) return null;
  const field = (context.fields ?? []).find((candidate) => (
    workflowFieldAliases(candidate).some((alias) => ` ${normalized} `.includes(` ${alias} `))
      && Object.hasOwn(object(state.collectedToolFields), candidate.key)
  ));
  if (!field) return null;
  const value = state.collectedToolFields[field.key];
  const label = cleanText(field.label ?? field.key, 120) || field.key;
  return Object.freeze({
    decision: 'RESPONSE', response: `${label}: ${cleanText(value, 500)}`,
    clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function factualSideRequest(utterance) {
  const normalized = scalarIdentity(utterance);
  return /[?\uFF1F]/u.test(cleanText(utterance))
    || /\b(?:what|which|who|where|when|why|how|explain|tell)\b/iu.test(normalized)
    || /(?:விலை|எவ்வளவு|விவரம்|என்னென்ன|எங்கே|எங்கிருந்து|யார்|எப்போது|பேக்கேஜ்|டெஸ்ட்|வித்தியாசம்|ஒப்பிடு)/u.test(normalized)
    || /(?:விலை|எவ்வளவு|விவரம்|என்னென்ன|எங்கே|எங்கிருந்து|யார்|எப்போது|பேக்கேஜ்|பேக்கேஜ்|டெஸ்ட்|வித்தியாசம்|ஒப்பிடு)/u.test(normalized);
}

function deterministicActiveWorkflowFallback(context, utterance) {
  if (!context?.toolName) return null;
  if (factualSideRequest(utterance)) return null;
  return Object.freeze({
    decision: 'TOOL', response: '', clarification: null, search: null,
    tool: Object.freeze({ name: context.toolName, arguments: Object.freeze({}) }),
    nextQuestion: null, stateUpdate: null,
  });
}

// This bypasses only classification of an exact scalar answer to the one
// configured pending field. Collection still re-resolves workflow/tool scope,
// validates the field schema, persists state and requires final confirmation.
export function deterministicPendingWorkflowFieldDecision(context, utterance, options = {}) {
  if (!context?.pendingFieldKey || context.awaitingConfirmation
    || cleanText(context.interruptedRequest)) return null;
  const field = (context.fields ?? []).find((entry) => entry.key === context.pendingFieldKey);
  const schemaType = cleanText(field?.type ?? field?.schema?.type, 40).toLocaleLowerCase();
  if (!field || !deterministicWorkflowFieldTypes.has(schemaType)) return null;
  const text = cleanText(utterance, 1_000);
  const words = text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  if (reviewedTextWorkflowFieldTypes.has(schemaType)) {
    const excluded = new Set((options.excludedPhrases ?? [])
      .map((value) => scalarIdentity(value)).filter(Boolean));
    const identity = scalarIdentity(text);
    const repeatsStoredField = Object.entries(object(context.collectedFields)).some(
      ([key, value]) => key !== field.key && scalarIdentity(value) === identity,
    );
    const containsExcludedControl = [...excluded].some((phrase) => (
      ` ${identity} `.includes(` ${phrase} `)
    ));
    const mentionsAnotherField = (context.fields ?? []).some((entry) => (
      entry.key !== field.key && workflowFieldAliases(entry).some((alias) => (
        ` ${identity} `.includes(` ${alias} `)
      ))
    ));
    const conversationalRequest = /\b(?:can|could|would|please)\b.*\b(?:speak|repeat|explain|help|wait)\b/iu
      .test(text);
    if (!text || text.length > 240 || words.length < 1 || words.length > 20
      || /[?？]/u.test(text) || containsExcludedControl || mentionsAnotherField
      || repeatsStoredField
      || conversationalRequest || factualSideRequest(text)
      || /\b(?:change|correct|correction|update|replace|wrong)\b/iu.test(text)
      || /\b(?:sorry|pardon|maybe|perhaps)\b/iu.test(text)
      || /(?:மாற்று|திருத்து|தப்பு|தவறு|மன்னிக்க)/u.test(text)) return null;
  }
  const value = extractSchemaFieldValue({
    ...field.schema, type: schemaType, question: field.question, label: field.key,
  }, utterance, {
    history: [{ role: 'assistant', content: field.question }], onlyMissing: true,
  });
  if (value === undefined || scalarIdentity(utterance) !== scalarIdentity(value)) return null;
  return Object.freeze({
    decision: 'TOOL', response: '', clarification: null, search: null,
    tool: Object.freeze({ name: context.toolName,
      arguments: Object.freeze({ [field.key]: value }) }),
    nextQuestion: null, stateUpdate: null,
  });
}

export function deterministicAcknowledgementDecision({
  utterance, acknowledgementPhrases = [], workflowContext, pendingQuestion,
  deferWithoutPending = false,
} = {}) {
  const confirmation = workflowContext?.awaitingConfirmation && phraseContained(utterance, [
    ...acknowledgementPhrases, 'yes', 'confirm', 'confirmed', 'proceed', 'go ahead',
    'ஆம்', 'ஆமாம்', 'சரி', 'உறுதி', 'புக் பண்ணுங்க',
  ]);
  if (!confirmation
    && !deterministicAcknowledgementOnly(utterance, acknowledgementPhrases)) return null;
  if (workflowContext?.pendingFieldKey && !workflowContext.awaitingConfirmation
    && !cleanText(workflowContext.interruptedRequest) && workflowContext.toolName) {
    return Object.freeze({
      decision: 'TOOL', response: '', clarification: null, search: null,
      tool: Object.freeze({ name: workflowContext.toolName, arguments: Object.freeze({}) }),
      nextQuestion: null, stateUpdate: null,
    });
  }
  if (confirmation && workflowContext.toolName) {
    return Object.freeze({
      decision: 'TOOL', response: '', clarification: null, search: null,
      tool: Object.freeze({ name: workflowContext.toolName, arguments: Object.freeze({}) }),
      nextQuestion: null,
      stateUpdate: Object.freeze({
        set: Object.freeze({ confirmationStatus: 'confirmed' }), clear: Object.freeze([]),
      }),
    });
  }
  const question = cleanText(
    pendingQuestion?.question ?? pendingQuestion?.text ?? pendingQuestion, 1_000,
  );
  if (!question) {
    if (deferWithoutPending) return null;
    return Object.freeze({
      decision: 'RESPONSE',
      response: tamilSpeech(utterance) ? 'சரி, சொல்லுங்க.' : 'Okay, please go ahead.',
      clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
    });
  }
  return Object.freeze({
    decision: 'CLARIFY', response: '', search: null, tool: null,
    clarification: Object.freeze({
      reason: 'acknowledgement_pending_question', question, candidates: Object.freeze([]),
    }),
    nextQuestion: null, stateUpdate: null,
  });
}

export function deterministicPendingClarificationContinuation({
  utterance, acknowledgementPhrases = [],
  pendingClarification, unansweredRequest = null,
} = {}) {
  if (!deterministicAcknowledgementOnly(utterance, acknowledgementPhrases)) return null;
  const candidates = Array.isArray(pendingClarification?.candidates)
    ? pendingClarification.candidates.map((candidate) => cleanText(candidate, 300)).filter(Boolean)
    : [];
  if (candidates.length !== 1) return null;
  return Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: [candidates[0], cleanText(unansweredRequest, 1_000)].filter(Boolean).join(' '),
      requestedFact: cleanText(unansweredRequest, 1_000) || candidates[0],
      contextualReference: candidates[0],
      preferredRecordIds: Object.freeze([]),
    }),
    tool: null, nextQuestion: null, stateUpdate: null,
  });
}

function mostRecentAssistantQuestion(turns = []) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role !== 'assistant') continue;
    const text = cleanText(turns[index]?.content, 1_000);
    if (/[?？]\s*$/u.test(text)) return text;
    if (/[?？]\s*$/u.test(text)) return text;
    break;
  }
  return null;
}

async function runWorkflow(input, decision, state, context, dependencies) {
  const workflows = context.publishedWorkflows;
  const candidates = callerVerifiedArguments(
    decision.tool?.arguments,
    input.latestUtterance,
    input.interruptedWorkflowRequest
      ? [...state.recentCompleteTurns, { role: 'user', content: input.interruptedWorkflowRequest }]
      : state.recentCompleteTurns,
    state.collectedToolFields,
  );
  const explicitConfirmation = state.confirmationStatus === 'awaiting_confirmation'
    && !input.interruptedWorkflowRequest
    && decision.stateUpdate?.set?.confirmationStatus === 'confirmed'
    && Object.keys(candidates).length === 0;
  const resultConversationGuidance = selectApplicableConversationGuidance({
    publishedConversationGuidance: context.publishedConversationGuidance ?? [],
    scope: context.scope,
    latestUtterance: input.latestUtterance,
    finalDecision: 'TOOL_RESULT',
    currentIntent: 'TOOL_RESULT',
    conversationStage: 'workflow result',
    language: input.language,
    recentCompleteTurns: state.recentCompleteTurns,
  });
  reportGuidanceSelection(
    dependencies.onConversationGuidanceSelected, 'workflow_result', resultConversationGuidance,
  );
  const transition = await advanceTemplateEngineWorkflowTurn({
    toolDecision: decision,
    state,
    publishedWorkflows: workflows,
    assignedTools: input.assignedTools,
    informationFields: input.informationFields,
    scope: context.scope,
    candidateValues: candidates,
    selectedRecordIds: state.lastReferencedRecordIds,
    candidateValuesVerified: true,
    confirmation: { accepted: explicitConfirmation, explicit: explicitConfirmation },
    confirmationMessage: input.confirmationMessage,
    mainPrompt: input.mainPrompt,
    language: input.language,
    conversationGuidance: resultConversationGuidance,
  }, {
    invokeStructuredLlm: dependencies.invokeStructuredLlm,
    persistWorkflowState: dependencies.persistWorkflowState,
    executeAuthorizedTool: dependencies.executeAuthorizedTool,
    getCachedWorkflowSpeech: dependencies.getCachedWorkflowSpeech,
    cacheWorkflowSpeech: dependencies.cacheWorkflowSpeech,
  });
  const finished = ['SUCCEEDED', 'FAILED'].includes(transition.status);
  dependencies.onWorkflowDiagnostics?.(Object.freeze({
    status: transition.status,
    workflowRecordId: transition.workflowRecordId ?? null,
    toolId: transition.toolId ?? null,
    selectedRecordIds: Object.freeze([...state.lastReferencedRecordIds]),
    acceptedFields: transition.acceptedFields ?? Object.freeze([]),
    rejectedFields: transition.rejectedFields ?? Object.freeze([]),
    collectedFieldKeys: Object.freeze(Object.keys(
      transition.state?.collectedToolFields ?? {},
    )),
    confirmationStatus: transition.state?.confirmationStatus ?? null,
    verifiedResult: transition.verifiedResult?.verified === true,
    success: transition.verifiedResult?.success ?? null,
  }));
  return Object.freeze({
    decision,
    speech: transition.speech,
    state: createMinimalTemplateEngineState({
      conversationHistory: state.recentCompleteTurns,
      lastReferencedRecordIds: state.lastReferencedRecordIds,
      comparisonRecordIds: state.comparisonRecordIds,
      pendingClarification: null,
      activeWorkflowId: transition.state.activeWorkflowId,
      collectedToolFields: transition.state.collectedToolFields,
      confirmationStatus: transition.state.confirmationStatus,
    }),
    evidence: Object.freeze([]),
    evidenceIds: [],
    workflow: transition,
    toolExecuted: finished,
    followUpValidation: transition.followUpValidation,
    provenance: responseProvenance({
      initialDecision: 'TOOL',
      finalDecision: finished ? 'TOOL_RESULT' : 'CLARIFY',
      workflowId: transition.workflowRecordId
        ?? state.activeWorkflowId ?? transition.state.activeWorkflowId,
      toolId: transition.toolId ?? decision.tool?.name,
      validationResult: finished
        ? (transition.verifiedResult?.verified === true ? 'verified_tool_result' : 'unverified_tool_result')
        : 'workflow_state_valid',
      clarificationReason: finished ? null
        : transition.status === 'AWAITING_FIELD'
          ? 'missing_workflow_field'
          : transition.status === 'AWAITING_CONFIRMATION'
            ? 'workflow_confirmation_required'
            : 'workflow_input_required',
    }),
  });
}

export async function runTemplateEngineProductionTurn(input = {}, dependencies = {}) {
  for (const dependency of [
    'invokeStructuredLlm', 'loadWorkflowContext', 'retrieveQdrantKnowledge',
    'runQdrantGroundedTurn',
    'persistWorkflowState', 'executeAuthorizedTool',
  ]) {
    if (typeof dependencies[dependency] !== 'function') {
      throw new TypeError(`Template-engine production runtime requires ${dependency}`);
    }
  }
  dependencies = instrumentTemplateEngineTurn(dependencies);
  const llmTurn = createSingleLlmTurnInvoker(
    dependencies.invokeStructuredLlm, dependencies.onLlmInvocation,
  );
  dependencies = { ...dependencies, invokeStructuredLlm: llmTurn.invoke };
  const finalizeTurn = (result, { requireExactlyOne = false, turnKind = 'deterministic' } = {}) => {
    const llmArchitecture = assertSingleLlmTurnArchitecture({
      invocationCount: llmTurn.count(), requireExactlyOne, turnKind,
    });
    return Object.freeze({
      ...result,
      llmInvocationCount: llmArchitecture.invocationCount,
      llmArchitecture,
    });
  };
  const assertCurrentTurn = () => {
    if (typeof dependencies.isTurnCurrent === 'function' && !dependencies.isTurnCurrent()) {
      const error = new Error('Template-engine turn was cancelled before retrieval reuse');
      error.name = 'AbortError';
      throw error;
    }
  };
  input = { ...input, maximumSpeechCharacters: normalizedSpeechBudget(input.maximumSpeechCharacters
    ?? input.runtimeProfile?.limits?.ttsMaxCharactersPerResponse) };
  // Start the publication I/O first. Minimal state and prompt preparation are
  // synchronous and independent, so they can run while that request is active.
  const workflowContextPromise = dependencies.loadWorkflowContext({
    auth: input.auth,
    scope: input.scope,
    callId: input.callId,
    usageDirection: input.usageDirection,
    language: input.language,
  });
  const state = createMinimalTemplateEngineState({
    conversationHistory: input.conversationHistory,
    ...object(input.state),
  });
  const preparedMainPrompt = [
    input.mainPrompt, speechBudgetInstruction(input.maximumSpeechCharacters),
  ].filter(Boolean).join('\n');
  const publishedContext = await workflowContextPromise;
  const workflowSummaries = authorizedWorkflowSummaries(
    publishedContext.publishedWorkflows, input.assignedTools,
  );
  // Guidance that is selected before the route is known can bias an ordinary
  // conversational turn toward whichever published record happens to score
  // highest. Route first, then select guidance against that concrete route.
  const initialConversationGuidance = null;
  reportGuidanceSelection(
    dependencies.onConversationGuidanceSelected, 'deterministic_resolution', initialConversationGuidance,
  );
  const common = {
    mainPrompt: preparedMainPrompt,
    latestUtterance: input.latestUtterance,
    conversationHistory: state.recentCompleteTurns,
    pendingClarification: state.pendingClarification,
    activeWorkflowState: state,
    lastReferencedRecordIds: state.lastReferencedRecordIds,
    comparisonRecordIds: state.comparisonRecordIds,
    activeWorkflowId: state.activeWorkflowId,
    collectedToolFields: state.collectedToolFields,
    confirmationStatus: state.confirmationStatus,
    authorizedWorkflowTools: workflowSummaries,
    conversationGuidance: initialConversationGuidance,
    pendingQuestion: input.pendingQuestion,
    welcomeContinuation: welcomeContinuationContext({
      pendingQuestion: input.pendingQuestion, latestUtterance: input.latestUtterance,
      publishedConversationGuidance: publishedContext.publishedConversationGuidance,
      scope: publishedContext.scope, recentCompleteTurns: state.recentCompleteTurns,
      activeWorkflowId: state.activeWorkflowId, pendingClarification: state.pendingClarification,
    }),
    unansweredRequest: input.unansweredRequest,
  };
  const workflowRoutingContext = templateEngineWorkflowRoutingContext({
    state, publishedWorkflows: publishedContext.publishedWorkflows,
    assignedTools: input.assignedTools, informationFields: input.informationFields,
    scope: publishedContext.scope, interruptedRequest: input.interruptedWorkflowRequest,
  });
  const welcomeAcknowledgementPending = Boolean(common.welcomeContinuation)
    || input.pendingQuestion?.key === 'configured_welcome_question'
    || Number(input.turnEpoch) === 1;
  const deterministicPriorityControl = deterministicConversationControlDecision({
    utterance: input.latestUtterance,
    explicitStopPhrases: input.explicitStopPhrases,
    state,
  });
  const deterministicWorkflowDecision = deterministicPriorityControl ? null
    : deterministicPendingWorkflowFieldDecision(
    workflowRoutingContext, input.latestUtterance,
    { excludedPhrases: [
      ...(input.acknowledgementPhrases ?? []), ...(input.explicitStopPhrases ?? []),
    ] },
  );
  const deterministicWorkflowCorrection = deterministicWorkflowDecision ? null
    : deterministicWorkflowCorrectionDecision(
      workflowRoutingContext,
      input.interruptedWorkflowRequest ?? input.latestUtterance,
      state,
    );
  const deterministicWorkflowReadback = deterministicWorkflowDecision
    || deterministicWorkflowCorrection ? null
    : deterministicWorkflowReadbackDecision(workflowRoutingContext, input.latestUtterance, state);
  const deterministicConversationControl = deterministicPriorityControl
    ?? (deterministicWorkflowDecision
    || deterministicWorkflowCorrection || deterministicWorkflowReadback ? null
    : deterministicConversationControlDecision({
      utterance: input.latestUtterance,
      explicitStopPhrases: input.explicitStopPhrases,
      state,
    }));
  const deterministicIdentityQuestion = deterministicWorkflowDecision
    || deterministicWorkflowCorrection || deterministicWorkflowReadback
    || deterministicConversationControl ? null
    : deterministicIdentityQuestionDecision({
      utterance: input.latestUtterance, runtimeProfile: input.runtimeProfile,
    });
  const deterministicClarificationContinuation = deterministicWorkflowDecision
    || deterministicWorkflowCorrection || deterministicWorkflowReadback
    || deterministicConversationControl || deterministicIdentityQuestion ? null
    : deterministicPendingClarificationContinuation({
      utterance: input.latestUtterance,
      acknowledgementPhrases: input.acknowledgementPhrases,
      pendingClarification: state.pendingClarification,
      unansweredRequest: input.unansweredRequest,
    });
  const deterministicAcknowledgement = deterministicWorkflowDecision
    || deterministicWorkflowCorrection || deterministicWorkflowReadback
    || deterministicConversationControl || deterministicIdentityQuestion
    || deterministicClarificationContinuation ? null
    : deterministicAcknowledgementDecision({
      utterance: input.latestUtterance,
      acknowledgementPhrases: input.acknowledgementPhrases,
      workflowContext: workflowRoutingContext,
      // Published welcome continuation owns acknowledgements to the welcome
      // question because it carries the configured next-step semantics.
      pendingQuestion: common.welcomeContinuation ? null
        : input.pendingQuestion ?? mostRecentAssistantQuestion(state.recentCompleteTurns),
      deferWithoutPending: welcomeAcknowledgementPending,
    });
  const workflowFieldDecision = deterministicWorkflowDecision
    ?? deterministicWorkflowCorrection ?? deterministicAcknowledgement ?? null;
  const deterministicWelcomeMeaning = workflowFieldDecision
    || deterministicIdentityQuestion || deterministicClarificationContinuation ? null
    : deterministicWelcomeContinuation({
      latestUtterance: input.latestUtterance,
      welcomeContinuation: common.welcomeContinuation,
      acknowledgementPhrases: input.acknowledgementPhrases,
    });
  const deterministicWelcomeDecision = deterministicWelcomeMeaning ? Object.freeze({
    decision: 'SEARCH', response: '', clarification: null,
    search: Object.freeze({
      query: deterministicWelcomeMeaning.query,
      requestedFact: deterministicWelcomeMeaning.requestedFact,
      contextualReference: null,
      preferredRecordIds: Object.freeze([]),
    }),
    tool: null, nextQuestion: null, stateUpdate: null,
  }) : null;
  const deterministicWorkflowMatch = workflowFieldDecision || deterministicIdentityQuestion
    || deterministicWelcomeDecision
    || state.activeWorkflowId ? null
    : deterministicConfiguredWorkflowMatch(
      input.latestUtterance, publishedContext.publishedWorkflows,
    );
  const deterministicWorkflowActivation = deterministicWorkflowActivationDecision(
    deterministicWorkflowMatch, publishedContext.publishedWorkflows, input.assignedTools,
  );
  const deterministicContextualWorkflowActivation = deterministicWorkflowActivation ? null
    : deterministicContextualWorkflowActivationDecision({
      utterance: input.latestUtterance, state, workflowSummaries,
    });
  const deterministicActiveWorkflow = workflowFieldDecision || deterministicConversationControl
    || deterministicWorkflowReadback || !state.activeWorkflowId ? null
    : deterministicActiveWorkflowFallback(workflowRoutingContext, input.latestUtterance);
  const deterministicDecision = workflowFieldDecision ?? deterministicWorkflowReadback
    ?? deterministicConversationControl
    ?? deterministicIdentityQuestion
    ?? deterministicClarificationContinuation
    ?? deterministicWelcomeDecision
    ?? deterministicWorkflowActivation ?? deterministicContextualWorkflowActivation
    ?? deterministicActiveWorkflow
    ?? deterministicUnresolvedSearchDecision(input.latestUtterance);
  const routed = Object.freeze({
    decision: deterministicDecision,
    outputValidation: Object.freeze({ valid: true, reason: deterministicWorkflowDecision
      ? 'verified_pending_field_fast_path' : deterministicWorkflowCorrection
        ? 'verified_workflow_correction_fast_path' : deterministicWorkflowReadback
          ? 'verified_workflow_readback_fast_path' : deterministicConversationControl
          ? 'verified_conversation_control_fast_path' : deterministicAcknowledgement
        ? 'verified_acknowledgement_fast_path' : deterministicIdentityQuestion
          ? 'verified_identity_question_fast_path' : deterministicClarificationContinuation
          ? 'verified_clarification_continuation_fast_path' : deterministicWelcomeDecision
            ? 'verified_pending_question_fast_path' : deterministicWorkflowActivation
                ? 'verified_workflow_activation_fast_path'
                : deterministicContextualWorkflowActivation
                  ? 'verified_contextual_workflow_activation_fast_path'
                : deterministicActiveWorkflow
                    ? 'verified_active_workflow_fast_path'
                    : 'deterministic_unresolved_search' }),
  });
  let first = routed.decision;
  const initialValidationResult = routed.outputValidation?.reason ?? 'valid';
  if (first.decision === 'TOOL') {
    dependencies.onTurnResolved?.({ decision: 'TOOL', activeWorkflow: Boolean(state.activeWorkflowId) });
    const workflowResult = await runWorkflow(input, first, state, publishedContext, dependencies);
    return finalizeTurn(workflowResult, { turnKind: 'workflow' });
  }
  dependencies.onTurnResolved?.({ decision: first.decision, activeWorkflow: Boolean(state.activeWorkflowId) });
  if (first.decision !== 'SEARCH') {
    const directConversationGuidance = selectApplicableConversationGuidance({
      publishedConversationGuidance: publishedContext.publishedConversationGuidance ?? [],
      scope: publishedContext.scope,
      latestUtterance: input.latestUtterance,
      finalDecision: first.decision,
      currentIntent: first.decision,
      recentCompleteTurns: state.recentCompleteTurns,
      conversationStage: conversationStage(state, first),
      language: input.language,
    });
    reportGuidanceSelection(
      dependencies.onConversationGuidanceSelected, 'direct_response', directConversationGuidance,
    );
    const composed = composeDeterministicSpeech({
      decision: first,
      mainPrompt: input.mainPrompt,
      latestUtterance: input.latestUtterance,
      recentCompleteTurns: state.recentCompleteTurns,
      conversationGuidance: directConversationGuidance,
      evidence: [],
      maximumSpeechCharacters: input.maximumSpeechCharacters,
      invokeStructuredLlm: dependencies.invokeStructuredLlm,
      onDiagnostics: (details) => dependencies.onFollowUpDiagnostics?.(Object.freeze({
        phase: 'direct_response', ...details,
      })),
    });
    first = composed.decision;
    const speech = composed.speech;
    if (!speech) throw new AppError(502, 'Template engine produced no caller speech', 'TEMPLATE_ENGINE_SILENT_TURN');
    return finalizeTurn({
      decision: first, speech, state: applyDecisionState(state, first, [], {
        preservePendingClarification: Boolean(
          deterministicIdentityQuestion || deterministicAcknowledgement,
        ),
      }),
      evidence: Object.freeze([]), evidenceIds: Object.freeze([]),
      workflow: null, toolExecuted: false,
      provenance: responseProvenance({
        initialDecision: first.decision,
        finalDecision: first.decision,
        validationResult: initialValidationResult,
        clarificationReason: first.clarification?.reason ?? null,
      }),
      followUpValidation: composed.followUp,
    }, { turnKind: 'conversational_control' });
  }

  assertCurrentTurn();
  {
    const qdrantRetrieval = await dependencies.retrieveQdrantKnowledge({
      tenantId: input.auth?.tenantId,
      agentId: input.scope?.agentId,
      question: input.latestUtterance,
      previousContext: state.recentCompleteTurns,
      cancellationSignal: input.cancellationSignal,
    });
    assertCurrentTurn();
    const retrievalArchitecture = assertQdrantFactualRetrievalArchitecture(
      qdrantRetrieval.diagnostics,
    );
    dependencies.onRetrievalDiagnostics?.(qdrantRetrieval.diagnostics);
    const grounded = await dependencies.runQdrantGroundedTurn({
      retrieval: qdrantRetrieval,
      tenantId: input.auth?.tenantId,
      agentId: input.scope?.agentId,
      currentQuestion: input.latestUtterance,
      previousContext: state.recentCompleteTurns,
      cancellationSignal: input.cancellationSignal,
      agentPrompt: input.mainPrompt,
      language: input.language,
      maximumSpeechCharacters: input.maximumSpeechCharacters,
    }, { invokeStructuredLlm: dependencies.invokeStructuredLlm });
    assertCurrentTurn();
    const finalState = applyDecisionState(state, grounded.decision, grounded.evidence);
    const architecture = Object.freeze({
      enforced: true,
      path: 'qdrant_contextual_one_llm',
      stages: Object.freeze([
        'deterministic_resolution', 'focused_retrieval', 'grounded_answer_generation',
        'deterministic_validation', 'tts_ready',
      ]),
      answerGenerationCalls: 1,
      retrieval: retrievalArchitecture,
      ttsReady: true,
    });
    return finalizeTurn({
      decision: grounded.decision,
      speech: grounded.speech,
      state: finalState,
      evidence: grounded.evidence,
      evidenceIds: grounded.evidenceIds,
      diagnostics: Object.freeze({
        retrieval: grounded.retrievalDiagnostics,
        postSearch: Object.freeze({ answerGenerationCalls: 1 }),
        architecture,
      }),
      workflow: null,
      toolExecuted: false,
      followUpValidation: Object.freeze({ accepted: false, reason: 'single_grounded_response' }),
      provenance: responseProvenance({
        initialDecision: 'SEARCH',
        finalDecision: grounded.decision.decision,
        evidenceIds: grounded.evidenceIds,
        validationResult: 'deterministic_qdrant_grounding_valid',
        searchPerformed: true,
        clarificationReason: grounded.decision.clarification?.reason ?? null,
      }),
    }, { requireExactlyOne: true, turnKind: 'factual' });
  }
}

export const productionTemplateEngineDependencies = Object.freeze({
  loadWorkflowContext: loadTemplateEngineWorkflowContext,
  retrieveQdrantKnowledge: retrieveAgentQdrantKnowledge,
  runQdrantGroundedTurn: runAgentQdrantGroundedTurn,
});
