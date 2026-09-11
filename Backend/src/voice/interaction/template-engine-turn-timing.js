// Per-turn timing for the Qdrant retrieval and single grounded LLM path.
const requestOperations = new WeakMap();
export function tagTemplateEngineTiming(request, operation) {
  requestOperations.set(request, operation);
  return request;
}

const operations = new Map([
  ['template_engine_post_search_decision', 'answer_generation'],
  ['agent_qdrant_grounded_answer', 'answer_generation'],
  ['template_engine_workflow_speech', 'workflow_speech_generation'],
]);

function timedOperationCalls(stageTimings, operation) {
  return Object.values(stageTimings ?? {}).reduce((total, stage) => (
    total + Number(stage?.operations?.[operation]?.calls ?? 0)
  ), 0);
}

export function assertVerifiedFactualStageArchitecture({ architecture, stageTimings } = {}) {
  if (architecture?.enforced !== true) {
    return Object.freeze({ enforced: false, path: 'reviewed_or_non_response' });
  }
  const calls = Object.freeze({
    retrieval: timedOperationCalls(stageTimings, 'retrieval'),
    answerGeneration: timedOperationCalls(stageTimings, 'answer_generation'),
    otherLlm: timedOperationCalls(stageTimings, 'other_llm'),
  });
  const violations = [];
  if (calls.retrieval !== 1) violations.push('focused_retrieval_must_run_once');
  if (calls.answerGeneration !== 1) violations.push('grounded_answer_generation_must_run_once');
  if (calls.otherLlm !== 0) violations.push('unexpected_llm_operation');
  if (architecture.ttsReady !== true) violations.push('deterministic_validation_not_tts_ready');
  if (violations.length) {
    const error = new Error('Verified factual turn violated measured stage architecture');
    error.code = 'TEMPLATE_ENGINE_STAGE_ARCHITECTURE_VIOLATION';
    error.details = Object.freeze({ violations: Object.freeze(violations), calls });
    throw error;
  }
  return Object.freeze({ enforced: true, path: architecture.path, calls, ttsReady: true });
}

export function instrumentTemplateEngineTurn(dependencies) {
  const origin = performance.now();
  const measured = (stage, invoke, extra = {}) => async (...args) => {
    const started = performance.now();
    let outcome = 'success';
    try { return await invoke(...args); }
    catch (error) { outcome = 'error'; throw error; }
    finally {
      dependencies.onStageTiming?.(Object.freeze({ stage,
        operation: extra.operation ?? stage,
        startedAtMs: Math.round((started - origin) * 100) / 100,
        endedAtMs: Math.round((performance.now() - origin) * 100) / 100,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        outcome, ...extra,
      }));
    }
  };
  return {
    ...dependencies,
    ...(typeof dependencies.loadWorkflowContext === 'function' ? {
      loadWorkflowContext: measured(
        'preparation', dependencies.loadWorkflowContext, { operation: 'workflow_context' },
      ),
    } : {}),
    ...(typeof dependencies.retrieveQdrantKnowledge === 'function' ? {
      retrieveQdrantKnowledge: measured(
        'retrieval', dependencies.retrieveQdrantKnowledge, { operation: 'retrieval' },
      ),
    } : {}),
    invokeStructuredLlm: (request) => measured(
      'generation',
      dependencies.invokeStructuredLlm,
      { operation: requestOperations.get(request)
        ?? operations.get(request.responseFormat?.name) ?? 'other_llm' },
    )(request),
  };
}
