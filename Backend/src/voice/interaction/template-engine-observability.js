import { summarizeTemplateEngineLatency } from './template-engine-latency-diagnostics.js';

function stageDuration(stageTimings, stage) {
  const value = Number(stageTimings?.[stage]?.durationMs);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function templateEngineAudioPercentiles(turns = []) {
  const summarize = (field) => {
    const values = turns.map((turn) => turn[field]).filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = (fraction) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
    return Object.freeze({ count: values.length, p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95) });
  };
  const actualAnswers = turns.filter((turn) => turn.normalVerifiedRequest !== false)
    .map((turn) => turn.finalAnswerFirstAudioMs)
    .filter(Number.isFinite);
  const actualAnswerAverageMs = actualAnswers.length
    ? Math.round((actualAnswers.reduce((total, value) => total + value, 0)
      / actualAnswers.length) * 100) / 100 : null;
  const actualAnswerMaximumMs = actualAnswers.length ? Math.max(...actualAnswers) : null;
  return Object.freeze({
    acknowledgement: summarize('acknowledgementFirstAudioMs'),
    finalAnswer: summarize('finalAnswerFirstAudioMs'),
    actualAnswerLatency: Object.freeze({
      measured: actualAnswers.length,
      averageMs: actualAnswerAverageMs,
      maximumObservedMs: actualAnswerMaximumMs,
      p95: summarize('finalAnswerFirstAudioMs').p95,
    }),
  });
}

export function recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch,
  result,
  retrievalDiagnostics = null,
  turnStartedAt,
  firstAudioAt = null,
  finalResponseReadyAt = null,
  finalResponseQueuedAt = null,
  firstFinalAudioAt = null,
  acknowledgementFirstAudioAt = null,
  sttFinalizationMs = null,
  stageTimings = {},
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
  const finalAnswerReadyMs = Number.isFinite(finalResponseReadyAt)
    && Number.isFinite(turnStartedAt)
    ? Math.max(0, finalResponseReadyAt - turnStartedAt) : null;
  const finalAnswerFirstAudioMs = Number.isFinite(firstFinalAudioAt)
    && Number.isFinite(turnStartedAt)
    ? Math.max(0, firstFinalAudioAt - turnStartedAt) : null;
  const answerQueueAfterReadyMs = Number.isFinite(finalResponseQueuedAt)
    && Number.isFinite(finalResponseReadyAt)
    ? Math.max(0, finalResponseQueuedAt - finalResponseReadyAt) : null;
  const finalAnswerAudioAfterQueuedMs = Number.isFinite(firstFinalAudioAt)
    && Number.isFinite(finalResponseQueuedAt)
    ? Math.max(0, firstFinalAudioAt - finalResponseQueuedAt) : null;
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
    finalAnswerAudioAfterQueuedMs,
    answerQueueAfterReadyMs,
    normalVerifiedRequest: !result?.recoveryKind
      && !result?.operationalFailure
      && !result?.unexpectedFailure,
    stageTimings: Object.fromEntries(Object.entries(stageTimings).map(([stage, timing]) => [stage, { ...timing }])),
  };
  // Keep final-answer audio separate from optional acknowledgement audio so
  // production measurements reflect the generated answer itself.
  sample.actualAnswerBaseline = Object.freeze({
    normalVerifiedRequest: sample.normalVerifiedRequest,
    actualAnswerFirstAudioMs: finalAnswerFirstAudioMs,
    stages: Object.freeze({
      sttFinalizationMs: Number.isFinite(sttFinalizationMs) ? Math.max(0, sttFinalizationMs) : null,
      routingMs: stageDuration(stageTimings, 'routing'),
      retrievalMs: stageDuration(stageTimings, 'retrieval'),
      generationMs: stageDuration(stageTimings, 'generation'),
      answerQueueMs: sample.answerQueueAfterReadyMs,
      ttsFirstAudioMs: sample.finalAnswerAudioAfterQueuedMs
        ?? sample.finalAnswerAudioAfterReadyMs,
    }),
    acknowledgementFirstAudioMs: sample.acknowledgementFirstAudioMs,
    acknowledgementExcluded: true,
  });
  sample.workDiagnostics = summarizeTemplateEngineLatency(stageTimings, sample);
  runtimeMetrics.turnLatency.push(sample);
  return sample;
}
