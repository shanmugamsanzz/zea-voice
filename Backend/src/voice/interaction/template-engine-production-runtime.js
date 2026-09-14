import { AppError } from '../../middleware/errors.js';
import { instrumentTemplateEngineTurn } from './template-engine-turn-timing.js';
import { normalizedSpeechBudget, speechBudgetInstruction } from './template-engine-speech-budget.js';
import {
  applyMinimalTemplateEngineStateUpdate,
  createMinimalTemplateEngineState,
} from './template-engine-state.js';
import { retrieveAgentQdrantKnowledge } from './agent-qdrant-retrieval.js';
import { runAgentQdrantUniversalTurn } from './agent-qdrant-grounded-turn.js';
import { buildUniversalTurnContext } from './universal-turn-context.js';
import {
  UNIVERSAL_TURN_LATENCY_BUDGET,
  universalStageDeadline,
} from './universal-turn-latency-budget.js';
import {
  applyUniversalWorkflowResult,
  buildUniversalWorkflowDefinitions,
} from './template-engine-universal-workflow.js';

export const TEMPLATE_ENGINE_PRODUCTION_RUNTIME_VERSION = 6;

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function retrieveWithinDeadline(invoke, input, turnDeadlineAt) {
  const controller = new AbortController();
  const upstream = input.cancellationSignal;
  const cancelFromUpstream = () => controller.abort(upstream?.reason ?? 'turn_cancelled');
  if (upstream?.aborted) cancelFromUpstream();
  else upstream?.addEventListener?.('abort', cancelFromUpstream, { once: true });
  const deadlineAt = universalStageDeadline({
    turnDeadlineAt,
    maximumMs: UNIVERSAL_TURN_LATENCY_BUDGET.retrievalMs,
  });
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AppError(504, 'Contextual retrieval exceeded its turn budget',
        'VOICE_RETRIEVAL_DEADLINE', {
          maximumMs: UNIVERSAL_TURN_LATENCY_BUDGET.retrievalMs,
        }));
      controller.abort('retrieval_deadline');
    }, Math.max(1, deadlineAt - Date.now()));
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke({ ...input, cancellationSignal: controller.signal })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener?.('abort', cancelFromUpstream);
  }
}

function authenticatedRetrievalScope(input) {
  const tenantId = cleanText(input.auth?.tenantId, 200);
  const scopedTenantId = cleanText(input.scope?.tenantId, 200);
  const agentId = cleanText(input.scope?.agentId, 200);
  const activeAgentId = cleanText(input.runtimeProfile?.agent?.id, 200);
  const activeAgentTenantId = cleanText(input.runtimeProfile?.agent?.tenantId, 200);
  if (!tenantId || !agentId) {
    throw new AppError(403, 'Authenticated tenant and active agent are required',
      'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_REQUIRED');
  }
  if ((scopedTenantId && scopedTenantId !== tenantId)
    || (activeAgentId && activeAgentId !== agentId)
    || (activeAgentTenantId && activeAgentTenantId !== tenantId)) {
    throw new AppError(403, 'Authenticated tenant and active agent scope do not match',
      'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_MISMATCH');
  }
  return Object.freeze({ tenantId, agentId });
}

export function createSingleLlmTurnInvoker(invoke, onInvocation = null) {
  if (typeof invoke !== 'function') throw new TypeError('Single-LLM turn requires an invoker');
  let invocationCount = 0;
  return Object.freeze({
    invoke: async (request, invocationOptions = {}) => {
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
      onInvocation?.(Object.freeze({
        invocationCount,
        operation: request?.responseFormat?.name ?? null,
      }));
      return invoke(request, invocationOptions);
    },
    count: () => invocationCount,
  });
}

export function assertSingleLlmTurnArchitecture({
  invocationCount, requireExactlyOne = false, turnKind = 'contextual',
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
    throw new AppError(500, 'Contextual template-engine turn did not use exactly one LLM call',
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
    || returnedChunkCount > 2) violations.push('qdrant_must_return_at_most_two_chunks');
  if (maximumChunks !== 2) violations.push('qdrant_maximum_chunks_must_be_two');
  if (diagnostics.tenantAgentFiltered !== true) {
    violations.push('qdrant_search_must_be_tenant_agent_filtered');
  }
  if (violations.length) {
    throw new AppError(500, 'Contextual retrieval violated the Qdrant architecture',
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

function evidenceIds(decision) {
  return Array.isArray(decision?.evidenceIds) ? decision.evidenceIds : [];
}

function applyTurnState(state, decision, evidence = []) {
  let next = state;
  if (decision?.stateUpdate) {
    next = applyMinimalTemplateEngineStateUpdate(next, decision.stateUpdate);
  }
  const recordsByEvidenceId = new Map(evidence.map((record) => [
    record.evidenceId, record.recordId,
  ]));
  const citedRecordIds = evidenceIds(decision)
    .map((id) => recordsByEvidenceId.get(id)).filter(Boolean);
  if (citedRecordIds.length) {
    next = applyMinimalTemplateEngineStateUpdate(next, {
      set: { lastReferencedRecordIds: citedRecordIds }, clear: [],
    });
  }
  if (decision?.decision === 'CLARIFY') {
    return applyMinimalTemplateEngineStateUpdate(next, {
      set: { pendingClarification: decision.clarification }, clear: [],
    });
  }
  if (next.pendingClarification) {
    return applyMinimalTemplateEngineStateUpdate(next, {
      set: {}, clear: ['pendingClarification'],
    });
  }
  return next;
}

function responseProvenance(decision, citedEvidenceIds, workflow = null) {
  return Object.freeze({
    initialDecision: 'SEARCH',
    finalDecision: decision?.decision ?? null,
    evidenceIds: Object.freeze([...new Set(citedEvidenceIds)]),
    workflowId: workflow?.id ?? null,
    toolId: workflow?.id ?? null,
    searchPerformed: true,
    clarificationReason: decision?.clarification?.reason ?? null,
  });
}

export async function runTemplateEngineProductionTurn(input = {}, dependencies = {}) {
  for (const dependency of [
    'invokeStructuredLlm', 'retrieveQdrantKnowledge', 'runQdrantUniversalTurn',
  ]) {
    if (typeof dependencies[dependency] !== 'function') {
      throw new TypeError(`Template-engine production runtime requires ${dependency}`);
    }
  }

  dependencies = instrumentTemplateEngineTurn(dependencies);
  const llmTurn = createSingleLlmTurnInvoker(
    dependencies.invokeStructuredLlm, dependencies.onLlmInvocation,
  );
  const assertCurrentTurn = () => {
    if (typeof dependencies.isTurnCurrent === 'function' && !dependencies.isTurnCurrent()) {
      const error = new Error('Template-engine turn was cancelled');
      error.name = 'AbortError';
      throw error;
    }
  };

  const maximumSpeechCharacters = normalizedSpeechBudget(input.maximumSpeechCharacters
    ?? input.runtimeProfile?.limits?.ttsMaxCharactersPerResponse);
  const retrievalScope = authenticatedRetrievalScope(input);
  const state = createMinimalTemplateEngineState({
    ...object(input.state),
    conversationHistory: input.conversationHistory ?? input.state?.recentCompleteTurns,
  });
  const conversationContext = buildUniversalTurnContext({
    currentQuestion: input.latestUtterance,
    conversationHistory: input.conversationHistory ?? state.recentCompleteTurns,
    pendingQuestion: input.pendingQuestion ?? state.pendingClarification?.question,
    speechStatus: input.speechStatus,
    conversationContextMode: input.conversationContextMode
      ?? input.runtimeProfile?.agent?.settings?.conversationContextMode,
    conversationContextTurns: input.conversationContextTurns
      ?? input.runtimeProfile?.agent?.settings?.conversationContextTurns,
  });
  const agentPrompt = [
    input.mainPrompt,
    speechBudgetInstruction(maximumSpeechCharacters),
  ].filter(Boolean).join('\n');
  const workflowDefinitions = buildUniversalWorkflowDefinitions({
    authorizedTools: input.authorizedWorkflowTools,
  });

  dependencies.onTurnResolved?.({
    decision: 'SEARCH',
    activeWorkflow: Boolean(state.activeWorkflowId),
  });
  assertCurrentTurn();

  const turnDeadlineAt = Number.isFinite(Number(input.turnDeadlineAt))
    ? Number(input.turnDeadlineAt)
    : Date.now() + UNIVERSAL_TURN_LATENCY_BUDGET.totalFirstAudioMs;
  const retrieval = await retrieveWithinDeadline(dependencies.retrieveQdrantKnowledge, {
    tenantId: retrievalScope.tenantId,
    agentId: retrievalScope.agentId,
    question: input.latestUtterance,
    previousContext: conversationContext.recentConversation,
    cancellationSignal: input.cancellationSignal,
  }, turnDeadlineAt);
  assertCurrentTurn();

  const retrievalArchitecture = assertQdrantFactualRetrievalArchitecture(
    retrieval.diagnostics,
  );
  dependencies.onRetrievalDiagnostics?.(retrieval.diagnostics);

  const universalTurn = await dependencies.runQdrantUniversalTurn({
    retrieval,
    tenantId: retrievalScope.tenantId,
    agentId: retrievalScope.agentId,
    currentQuestion: input.latestUtterance,
    previousContext: conversationContext.recentConversation,
    conversationContext,
    cancellationSignal: input.cancellationSignal,
    agentPrompt,
    workflowDefinitions,
    workflowState: state,
    language: input.language,
    maximumSpeechCharacters,
    onSpeechSentence: dependencies.onSpeechSentence,
    firstSentenceDeadlineAt: universalStageDeadline({
      turnDeadlineAt,
      maximumMs: UNIVERSAL_TURN_LATENCY_BUDGET.llmFirstSentenceMs,
      reserveMs: UNIVERSAL_TURN_LATENCY_BUDGET.ttsFirstAudioMs,
    }),
  }, { invokeStructuredLlm: llmTurn.invoke });
  assertCurrentTurn();

  const turnState = applyTurnState(state, universalTurn.decision, universalTurn.evidence);
  const workflowResult = await applyUniversalWorkflowResult({
    outcome: universalTurn.outcome,
    workflowAction: universalTurn.workflowAction,
    conversationContext,
    speech: universalTurn.speech,
    state: turnState,
    definitions: workflowDefinitions,
    persistWorkflowState: dependencies.persistWorkflowState,
    executeAuthorizedTool: dependencies.executeAuthorizedTool,
  });
  assertCurrentTurn();

  const llmArchitecture = assertSingleLlmTurnArchitecture({
    invocationCount: llmTurn.count(),
    requireExactlyOne: true,
    turnKind: 'contextual_qdrant',
  });
  const architecture = Object.freeze({
    enforced: true,
    path: 'qdrant_contextual_one_universal_llm',
    stages: Object.freeze([
      'contextual_search_text',
      'tenant_agent_qdrant_search',
      'universal_response_and_workflow_generation',
      'llm_output_accepted',
      'tts_ready',
    ]),
    answerGenerationCalls: 1,
    universalOperation: true,
    languageOrBusinessRouting: false,
    retrieval: retrievalArchitecture,
    ttsReady: true,
  });

  return Object.freeze({
    decision: universalTurn.decision,
    speech: universalTurn.speech,
    state: workflowResult.state,
    evidence: universalTurn.evidence,
    evidenceIds: universalTurn.evidenceIds,
    diagnostics: Object.freeze({
      retrieval: universalTurn.retrievalDiagnostics,
      postSearch: Object.freeze({ answerGenerationCalls: 1 }),
      architecture,
    }),
    workflow: workflowResult.workflow,
    toolExecuted: workflowResult.toolExecuted,
    toolResult: workflowResult.toolResult,
    callControl: universalTurn.outcome === 'CLOSING' ? 'close' : null,
    provenance: responseProvenance(
      universalTurn.decision, universalTurn.evidenceIds, workflowResult.workflow,
    ),
    llmInvocationCount: llmArchitecture.invocationCount,
    llmArchitecture,
  });
}

export const productionTemplateEngineDependencies = Object.freeze({
  retrieveQdrantKnowledge: retrieveAgentQdrantKnowledge,
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
});
