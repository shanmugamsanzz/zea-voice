// Per-turn timing and exact-input claim-validation reuse. Never shared across
// calls, tenants or publication revisions. Rejections are not cached.
export function instrumentTemplateEngineTurn(dependencies) {
  const measured = (stage, invoke, extra = {}) => async (...args) => {
    const started = performance.now();
    let outcome = 'success';
    try { return await invoke(...args); }
    catch (error) { outcome = 'error'; throw error; }
    finally {
      dependencies.onStageTiming?.(Object.freeze({ stage,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        outcome, ...extra,
      }));
    }
  };
  const validations = new Map();
  const validate = measured('validation', dependencies.validateGroundedClaims);
  return {
    ...dependencies,
    loadPublishedContext: measured('publication_load', dependencies.loadPublishedContext),
    retrieveEvidence: measured('retrieval', dependencies.retrieveEvidence),
    ...(dependencies.retrieveSpeculativeEvidence ? {
      retrieveSpeculativeEvidence: measured('speculative_retrieval', dependencies.retrieveSpeculativeEvidence),
    } : {}),
    invokeStructuredLlm: (request) => measured(
      request.responseFormat?.name === 'template_engine_orchestrator_decision' ? 'routing' : 'generation',
      dependencies.invokeStructuredLlm,
    )(request),
    validateGroundedClaims: (input) => {
      // Serialize the entire validation contract, including speech, citations,
      // scoped evidence, requested fact and current utterance.
      const key = JSON.stringify(input);
      if (validations.has(key)) {
        dependencies.onStageTiming?.(Object.freeze({ stage: 'validation', durationMs: 0,
          outcome: 'reused', cacheHit: true }));
        return validations.get(key);
      }
      const pending = validate(input).catch((error) => { validations.delete(key); throw error; });
      validations.set(key, pending);
      return pending;
    },
    validateToolResultSpeechClaims: measured('validation', dependencies.validateToolResultSpeechClaims),
  };
}
