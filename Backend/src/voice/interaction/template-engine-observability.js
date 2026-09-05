export const templateEngineFirstAudioTargets = Object.freeze({
  RESPONSE: 1_000,
  CLARIFY: 1_000,
  SEARCH: 3_000,
  TOOL: 2_000,
});

export function templateEngineAudioPercentiles(turns = []) {
  const summarize = (field) => {
    const values = turns.map((turn) => turn[field]).filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = (fraction) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
    return Object.freeze({ count: values.length, p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95) });
  };
  return Object.freeze({
    acknowledgement: summarize('acknowledgementFirstAudioMs'),
    finalAnswer: summarize('finalAnswerFirstAudioMs'),
  });
}

export function templateEngineFirstAudioTarget(result, fallbackMs = null) {
  const route = result?.provenance?.initialDecision ?? result?.decision?.decision ?? null;
  return templateEngineFirstAudioTargets[route]
    ?? (Number.isFinite(fallbackMs) ? fallbackMs : null);
}

export function recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch,
  result,
  retrievalDiagnostics = null,
  turnStartedAt,
  firstAudioAt = null,
  finalResponseReadyAt = null,
  firstFinalAudioAt = null,
  acknowledgementFirstAudioAt = null,
  stageTimings = {},
  firstAudioDeadlineMs,
} = {}) {
  if (!runtimeMetrics || typeof runtimeMetrics !== 'object') {
    throw new TypeError('Template-engine observability requires runtime metrics');
  }
  runtimeMetrics.templateEngine ??= { version: 1, mode: 'active', turns: 0, searches: 0, workflows: 0 };
  runtimeMetrics.turnLatency ??= [];
  runtimeMetrics.templateEngine.turns += 1;
  if (result?.provenance?.searchPerformed === true) runtimeMetrics.templateEngine.searches += 1;
  if (result?.workflow) runtimeMetrics.templateEngine.workflows += 1;
  const totalFirstAudioMs = Number.isFinite(firstAudioAt) && Number.isFinite(turnStartedAt)
    ? Math.max(0, firstAudioAt - turnStartedAt) : null;
  const targetMs = templateEngineFirstAudioTarget(result, firstAudioDeadlineMs);
  const finalAnswerReadyMs = Number.isFinite(finalResponseReadyAt)
    && Number.isFinite(turnStartedAt)
    ? Math.max(0, finalResponseReadyAt - turnStartedAt) : null;
  const finalAnswerFirstAudioMs = Number.isFinite(firstFinalAudioAt)
    && Number.isFinite(turnStartedAt)
    ? Math.max(0, firstFinalAudioAt - turnStartedAt) : null;
  const sample = {
    epoch,
    route: result?.provenance?.initialDecision ?? result?.decision?.decision ?? null,
    responseClass: result?.provenance?.finalDecision ?? result?.decision?.decision ?? null,
    retrievalMs: Number.isFinite(retrievalDiagnostics?.durationMs)
      ? retrievalDiagnostics.durationMs : null,
    totalFirstAudioMs,
    finalAnswerReadyMs,
    finalAnswerFirstAudioMs,
    acknowledgementFirstAudioMs: Number.isFinite(acknowledgementFirstAudioAt)
      ? Math.max(0, acknowledgementFirstAudioAt - turnStartedAt) : null,
    finalAnswerAudioAfterReadyMs: Number.isFinite(firstFinalAudioAt) && Number.isFinite(finalResponseReadyAt)
      ? Math.max(0, firstFinalAudioAt - finalResponseReadyAt) : null,
    stageTimings: Object.fromEntries(Object.entries(stageTimings).map(([stage, timing]) => [stage, { ...timing }])),
    finalAnswerStatus: finalAnswerFirstAudioMs === null || targetMs === null
      ? 'not_measured' : finalAnswerFirstAudioMs < targetMs ? 'passed' : 'missed',
    firstAudioTargetMs: targetMs,
    firstAudioStatus: totalFirstAudioMs === null || targetMs === null
      ? 'not_measured' : totalFirstAudioMs < targetMs ? 'passed' : 'missed',
  };
  runtimeMetrics.turnLatency.push(sample);
  return sample;
}
