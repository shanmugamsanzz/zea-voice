import { summarizeTemplateEngineLatency } from './template-engine-latency-diagnostics.js';

export const templateEngineFirstAudioTargets = Object.freeze({
  RESPONSE: 1_000,
  CLARIFY: 1_000,
  SEARCH: 3_000,
  TOOL: 2_000,
});

export const TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS = 3_000;
export const TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS = 4_000;
export const TEMPLATE_ENGINE_ACTUAL_ANSWER_MINIMUM_SAMPLES = 20;

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
  const actualAnswersUnderTarget = actualAnswers
    .filter((durationMs) => durationMs < TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS).length;
  const actualAnswerAverageMs = actualAnswers.length
    ? Math.round((actualAnswers.reduce((total, value) => total + value, 0)
      / actualAnswers.length) * 100) / 100 : null;
  const actualAnswerMaximumMs = actualAnswers.length ? Math.max(...actualAnswers) : null;
  return Object.freeze({
    acknowledgement: summarize('acknowledgementFirstAudioMs'),
    finalAnswer: summarize('finalAnswerFirstAudioMs'),
    actualAnswerUnderThreeSeconds: Object.freeze({
      targetMs: TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS,
      maximumMs: TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS,
      minimumSamples: TEMPLATE_ENGINE_ACTUAL_ANSWER_MINIMUM_SAMPLES,
      measured: actualAnswers.length,
      passed: actualAnswersUnderTarget,
      passRate: actualAnswers.length
        ? Math.round((actualAnswersUnderTarget / actualAnswers.length) * 10_000) / 100
        : null,
      averageMs: actualAnswerAverageMs,
      averageTargetStatus: actualAnswers.length < TEMPLATE_ENGINE_ACTUAL_ANSWER_MINIMUM_SAMPLES
        ? 'insufficient_live_samples'
        : actualAnswerAverageMs < TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS ? 'passed' : 'missed',
      maximumObservedMs: actualAnswerMaximumMs,
      maximumTargetStatus: actualAnswers.length < TEMPLATE_ENGINE_ACTUAL_ANSWER_MINIMUM_SAMPLES
        ? 'insufficient_live_samples'
        : actualAnswerMaximumMs <= TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS ? 'passed' : 'missed',
      p95: summarize('finalAnswerFirstAudioMs').p95,
      p95TargetStatus: actualAnswers.length < TEMPLATE_ENGINE_ACTUAL_ANSWER_MINIMUM_SAMPLES
        ? 'insufficient_live_samples'
        : summarize('finalAnswerFirstAudioMs').p95 < TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS
          ? 'passed' : 'missed',
    }),
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
  finalResponseQueuedAt = null,
  firstFinalAudioAt = null,
  acknowledgementFirstAudioAt = null,
  sttFinalizationMs = null,
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
      && !result?.validationFailure && !result?.operationalFailure
      && !result?.unexpectedFailure,
    stageTimings: Object.fromEntries(Object.entries(stageTimings).map(([stage, timing]) => [stage, { ...timing }])),
    finalAnswerStatus: finalAnswerFirstAudioMs === null || targetMs === null
      ? 'not_measured' : finalAnswerFirstAudioMs < targetMs ? 'passed' : 'missed',
    firstAudioTargetMs: targetMs,
    firstAudioStatus: totalFirstAudioMs === null || targetMs === null
      ? 'not_measured' : totalFirstAudioMs < targetMs ? 'passed' : 'missed',
  };
  // This baseline intentionally uses final-answer audio only. A latency
  // acknowledgement may make the call feel responsive, but cannot satisfy
  // the actual-answer target.
  sample.actualAnswerBaseline = Object.freeze({
    targetMs: TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS,
    maximumMs: TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS,
    normalVerifiedRequest: sample.normalVerifiedRequest,
    actualAnswerFirstAudioMs: finalAnswerFirstAudioMs,
    targetStatus: finalAnswerFirstAudioMs === null ? 'not_measured'
      : finalAnswerFirstAudioMs < TEMPLATE_ENGINE_ACTUAL_ANSWER_TARGET_MS ? 'passed' : 'missed',
    maximumStatus: finalAnswerFirstAudioMs === null || !sample.normalVerifiedRequest
      ? 'not_measured'
      : finalAnswerFirstAudioMs <= TEMPLATE_ENGINE_ACTUAL_ANSWER_MAXIMUM_MS ? 'passed' : 'missed',
    stages: Object.freeze({
      sttFinalizationMs: Number.isFinite(sttFinalizationMs) ? Math.max(0, sttFinalizationMs) : null,
      routingMs: stageDuration(stageTimings, 'routing'),
      retrievalMs: stageDuration(stageTimings, 'retrieval'),
      generationMs: stageDuration(stageTimings, 'generation'),
      validationMs: stageDuration(stageTimings, 'validation'),
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
