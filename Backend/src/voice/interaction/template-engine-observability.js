export const templateEngineFirstAudioTargets = Object.freeze({
  RESPONSE: 1_000,
  CLARIFY: 1_000,
  SEARCH: 3_000,
  TOOL: 2_000,
});

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
  const sample = {
    epoch,
    route: result?.provenance?.initialDecision ?? result?.decision?.decision ?? null,
    responseClass: result?.provenance?.finalDecision ?? result?.decision?.decision ?? null,
    retrievalMs: Number.isFinite(retrievalDiagnostics?.durationMs)
      ? retrievalDiagnostics.durationMs : null,
    totalFirstAudioMs,
    firstAudioTargetMs: targetMs,
    firstAudioStatus: totalFirstAudioMs === null || targetMs === null
      ? 'not_measured' : totalFirstAudioMs < targetMs ? 'passed' : 'missed',
  };
  runtimeMetrics.turnLatency.push(sample);
  return sample;
}
