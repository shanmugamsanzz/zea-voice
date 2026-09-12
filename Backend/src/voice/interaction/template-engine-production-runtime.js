import { AppError } from '../../middleware/errors.js';
import { instrumentTemplateEngineTurn } from './template-engine-turn-timing.js';
import { normalizedSpeechBudget, speechBudgetInstruction } from './template-engine-speech-budget.js';
import {
  applyMinimalTemplateEngineStateUpdate,
  createMinimalTemplateEngineState,
} from './template-engine-state.js';
import { retrieveAgentQdrantKnowledge } from './agent-qdrant-retrieval.js';
import { runAgentQdrantUniversalTurn } from './agent-qdrant-grounded-turn.js';
import {
  applyUniversalWorkflowResult,
  buildUniversalAgentConfiguration,
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
      onInvocation?.(Object.freeze({
        invocationCount,
        operation: request?.responseFormat?.name ?? null,
      }));
      return invoke(request);
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
    || returnedChunkCount > 3) violations.push('qdrant_must_return_at_most_three_chunks');
  if (maximumChunks !== 3) violations.push('qdrant_maximum_chunks_must_be_three');
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

function applyGroundedState(state, decision, evidence = []) {
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
    validationResult: 'deterministic_qdrant_grounding_valid',
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
    conversationHistory: input.conversationHistory,
    ...object(input.state),
  });
  const agentPrompt = [
    input.mainPrompt,
    speechBudgetInstruction(maximumSpeechCharacters),
  ].filter(Boolean).join('\n');
  const agentConfiguration = buildUniversalAgentConfiguration(input.runtimeProfile);
  const workflowDefinitions = buildUniversalWorkflowDefinitions({
    runtimeProfile: input.runtimeProfile,
    authorizedTools: input.authorizedWorkflowTools,
    informationFields: input.informationFields,
    confirmationMessage: input.confirmationMessage,
  });

  dependencies.onTurnResolved?.({
    decision: 'SEARCH',
    activeWorkflow: Boolean(state.activeWorkflowId),
  });
  assertCurrentTurn();

  const retrieval = await dependencies.retrieveQdrantKnowledge({
    tenantId: retrievalScope.tenantId,
    agentId: retrievalScope.agentId,
    question: input.latestUtterance,
    previousContext: state.recentCompleteTurns,
    cancellationSignal: input.cancellationSignal,
  });
  assertCurrentTurn();

  const retrievalArchitecture = assertQdrantFactualRetrievalArchitecture(
    retrieval.diagnostics,
  );
  dependencies.onRetrievalDiagnostics?.(retrieval.diagnostics);

  const grounded = await dependencies.runQdrantUniversalTurn({
    retrieval,
    tenantId: retrievalScope.tenantId,
    agentId: retrievalScope.agentId,
    currentQuestion: input.latestUtterance,
    previousContext: state.recentCompleteTurns,
    cancellationSignal: input.cancellationSignal,
    agentPrompt,
    agentConfiguration,
    workflowDefinitions,
    workflowState: state,
    language: input.language,
    maximumSpeechCharacters,
  }, { invokeStructuredLlm: llmTurn.invoke });
  assertCurrentTurn();

  const groundedState = applyGroundedState(state, grounded.decision, grounded.evidence);
  const workflowResult = await applyUniversalWorkflowResult({
    outcome: grounded.outcome,
    workflowAction: grounded.workflowAction,
    state: groundedState,
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
      'deterministic_validation',
      'tts_ready',
    ]),
    answerGenerationCalls: 1,
    universalOperation: true,
    languageOrBusinessRouting: false,
    retrieval: retrievalArchitecture,
    ttsReady: true,
  });

  return Object.freeze({
    decision: grounded.decision,
    speech: grounded.speech,
    state: workflowResult.state,
    evidence: grounded.evidence,
    evidenceIds: grounded.evidenceIds,
    diagnostics: Object.freeze({
      retrieval: grounded.retrievalDiagnostics,
      postSearch: Object.freeze({ answerGenerationCalls: 1 }),
      architecture,
    }),
    workflow: workflowResult.workflow,
    toolExecuted: workflowResult.toolExecuted,
    toolResult: workflowResult.toolResult,
    callControl: grounded.outcome === 'CLOSING' ? 'close' : null,
    followUpValidation: Object.freeze({ accepted: false, reason: 'single_grounded_response' }),
    provenance: responseProvenance(
      grounded.decision, grounded.evidenceIds, workflowResult.workflow,
    ),
    llmInvocationCount: llmArchitecture.invocationCount,
    llmArchitecture,
  });
}

export const productionTemplateEngineDependencies = Object.freeze({
  retrieveQdrantKnowledge: retrieveAgentQdrantKnowledge,
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
});
