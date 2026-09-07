// Per-turn timing and exact-input claim-validation reuse. Never shared across
// calls, tenants or publication revisions. Rejections are not cached.
const requestOperations = new WeakMap();
export function tagTemplateEngineTiming(request, operation) {
  requestOperations.set(request, operation);
  return request;
}

const operations = new Map([
  ['template_engine_orchestrator_decision', 'routing'],
  ['template_engine_post_search_decision', 'answer_generation'],
  ['template_engine_claim_validation', 'claim_review'],
  ['template_engine_contextual_subject_review', 'contextual_subject_review'],
  ['template_engine_entity_coverage', 'entity_coverage_review'],
  ['template_engine_multilingual_entity_review', 'multilingual_entity_review'],
  ['template_engine_reference_review', 'reference_review'],
  ['template_engine_pending_request_review', 'pending_request_review'],
  ['template_engine_welcome_meaning', 'request_meaning_review'],
  ['template_engine_follow_up_repair', 'follow_up_repair'],
  ['template_engine_workflow_speech', 'workflow_speech_generation'],
]);

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
  const reusableValidation = (invoke, operation, accepted) => {
    const completed = new Map();
    const pending = new Map();
    const validate = measured('validation', invoke, { operation });
    return async (input) => {
      const key = validationKey(input);
      if (key !== null && (completed.has(key) || pending.has(key))) {
        dependencies.onStageTiming?.(Object.freeze({ stage: 'validation', operation,
          durationMs: 0, outcome: pending.has(key) ? 'coalesced' : 'reused', cacheHit: true }));
        return structuredClone(completed.has(key) ? completed.get(key) : await pending.get(key));
      }
      const work = validate(input);
      if (key !== null && pending.size < 64) pending.set(key, work);
      let result;
      try { result = await work; }
      finally { if (key !== null && pending.get(key) === work) pending.delete(key); }
      // Only completed successful checks are retained. Identical concurrent
      // callers may share an in-flight check. Repair, cancellation,
      // malformed results and negative decisions must be evaluated afresh.
      if (key !== null && accepted(result) && completed.size < 64) {
        try { completed.set(key, structuredClone(result)); } catch { /* Not safely reusable. */ }
      }
      return result;
    };
  };
  return {
    ...dependencies,
    ...(dependencies.validateRequestedEntityCoverage ? {
      validateRequestedEntityCoverage: reusableValidation(dependencies.validateRequestedEntityCoverage,
        'entity_coverage_review', (result) => result?.resolved === true),
    } : {}),
    loadPublishedContext: measured('publication_load', dependencies.loadPublishedContext),
    retrieveEvidence: measured('retrieval', dependencies.retrieveEvidence),
    ...(dependencies.retrieveSpeculativeEvidence ? {
      retrieveSpeculativeEvidence: measured('speculative_retrieval', dependencies.retrieveSpeculativeEvidence),
    } : {}),
    invokeStructuredLlm: (request) => measured(
      request.responseFormat?.name === 'template_engine_orchestrator_decision' ? 'routing' : 'generation',
      dependencies.invokeStructuredLlm,
      { operation: requestOperations.get(request)
        ?? operations.get(request.responseFormat?.name) ?? 'other_llm' },
    )(request),
    validateGroundedClaims: reusableValidation(dependencies.validateGroundedClaims,
      'validation', (result) => result?.supported === true && result?.requestedFactAddressed !== false),
    validateToolResultSpeechClaims: reusableValidation(dependencies.validateToolResultSpeechClaims,
      'tool_result_validation', (result) => result?.supported === true),
  };
}
