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
  ['template_engine_pending_text_field', 'workflow_text_field_review'],
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
    routing: timedOperationCalls(stageTimings, 'routing'),
    answerGeneration: timedOperationCalls(stageTimings, 'answer_generation'),
    answerRepair: timedOperationCalls(stageTimings, 'answer_repair'),
    claimReview: timedOperationCalls(stageTimings, 'claim_review')
      + timedOperationCalls(stageTimings, 'validation'),
    semanticReviews: [
      'contextual_subject_review', 'entity_coverage_review', 'multilingual_entity_review',
      'reference_review', 'pending_request_review', 'request_meaning_review',
    ].reduce((total, operation) => total + timedOperationCalls(stageTimings, operation), 0),
  });
  const violations = [];
  if (calls.publicationLoad !== 1) violations.push('publication_load_must_run_once');
  if (calls.retrieval !== 1) violations.push('focused_retrieval_must_run_once');
  if (calls.routing !== 0) violations.push('routing_llm_must_be_skipped');
  if (calls.answerGeneration !== 1) violations.push('grounded_answer_generation_must_run_once');
  if (calls.claimReview !== 0 || calls.semanticReviews !== 0) {
    violations.push('semantic_validation_and_reviews_must_be_skipped');
  }
  const expectedRepairs = Math.max(0, Number(architecture.answerGenerationCalls) - 1);
  if (calls.answerRepair !== expectedRepairs
    || (expectedRepairs > 0 && architecture.answerRepairAttempted !== true)) {
    violations.push('answer_repairs_require_recorded_validation_failure');
  }
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
  const callbackIdentities = new WeakMap();
  let nextCallbackIdentity = 1;
  const callbackIdentity = (callback) => {
    if (typeof callback !== 'function') return callback == null ? 'none' : null;
    if (!callbackIdentities.has(callback)) callbackIdentities.set(callback, nextCallbackIdentity++);
    return callbackIdentities.get(callback);
  };
  const retrievalKey = (input) => {
    if (!input || typeof input !== 'object') return validationKey(input);
    const {
      reviewEntityCandidates,
      reviewContextualCandidates,
      ...contract
    } = input;
    const entityReviewer = callbackIdentity(reviewEntityCandidates);
    const contextualReviewer = callbackIdentity(reviewContextualCandidates);
    if (entityReviewer === null || contextualReviewer === null) return null;
    const contractKey = validationKey(contract);
    return contractKey === null ? null
      : `${contractKey}|entityReviewer:${entityReviewer}|contextualReviewer:${contextualReviewer}`;
  };
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
    ...(dependencies.validateRequestedEntityCoverage ? {
      validateRequestedEntityCoverage: reusableValidation(dependencies.validateRequestedEntityCoverage,
        'entity_coverage_review', (result) => result?.resolved === true),
    } : {}),
    loadPublishedContext: reusableOperation('publication_load', dependencies.loadPublishedContext,
      'publication_load', (result) => Boolean(result?.scope && result?.artifacts)),
    retrieveEvidence: reusableOperation('retrieval', dependencies.retrieveEvidence,
      'retrieval', (result) => Array.isArray(result?.evidence) && !result?.error, retrievalKey),
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
