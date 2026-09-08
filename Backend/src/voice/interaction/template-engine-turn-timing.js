// Per-turn timing and exact-input claim-validation reuse. Never shared across
// calls, tenants or publication revisions. Rejections are not cached.
const requestOperations = new WeakMap();
export function tagTemplateEngineTiming(request, operation) {
  requestOperations.set(request, operation);
  return request;
}

const operations = new Map([
  ['template_engine_post_search_decision', 'answer_generation'],
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
    publicationLoad: timedOperationCalls(stageTimings, 'publication_load'),
    retrieval: timedOperationCalls(stageTimings, 'retrieval'),
    answerGeneration: timedOperationCalls(stageTimings, 'answer_generation'),
    otherLlm: timedOperationCalls(stageTimings, 'other_llm'),
  });
  const violations = [];
  if (calls.publicationLoad !== 1) violations.push('publication_load_must_run_once');
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

// Sort object keys only: evidence/candidate/history array order remains part
// of the contract. Non-JSON values disable reuse rather than collide.
function validationKey(value) {
  const normalize = (entry) => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object'
      && [Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      return Object.fromEntries(Object.keys(entry).sort().filter((key) => entry[key] !== undefined)
        .map((key) => [key, normalize(entry[key])]));
    }
    throw new TypeError('Non-JSON validation input');
  };
  try { return JSON.stringify(normalize(value)); } catch { return null; }
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
  const reusableOperation = (stage, invoke, operation, accepted, keyFor = validationKey) => {
    const completed = new Map();
    const pending = new Map();
    const run = measured(stage, invoke, { operation });
    return async (input) => {
      // The complete input is the isolation boundary. AbortSignal, callbacks
      // and other non-JSON values intentionally disable reuse.
      const key = keyFor(input);
      if (key !== null && (completed.has(key) || pending.has(key))) {
        dependencies.onStageTiming?.(Object.freeze({ stage, operation,
          durationMs: 0, outcome: pending.has(key) ? 'coalesced' : 'reused', cacheHit: true }));
        const value = completed.has(key) ? completed.get(key) : await pending.get(key);
        return structuredClone(value);
      }
      const work = run(input);
      if (key !== null && pending.size < 32) pending.set(key, work);
      let result;
      try { result = await work; }
      finally { if (key !== null && pending.get(key) === work) pending.delete(key); }
      if (key !== null && accepted(result) && completed.size < 32) {
        try { completed.set(key, structuredClone(result)); } catch { /* Not safely reusable. */ }
      }
      return result;
    };
  };
  return {
    ...dependencies,
    loadPublishedContext: reusableOperation('publication_load', dependencies.loadPublishedContext,
      'publication_load', (result) => Boolean(result?.scope && result?.artifacts)),
    retrieveEvidence: reusableOperation('retrieval', dependencies.retrieveEvidence,
      'retrieval', (result) => Array.isArray(result?.evidence) && !result?.error),
    invokeStructuredLlm: (request) => measured(
      'generation',
      dependencies.invokeStructuredLlm,
      { operation: requestOperations.get(request)
        ?? operations.get(request.responseFormat?.name) ?? 'other_llm' },
    )(request),
  };
}
