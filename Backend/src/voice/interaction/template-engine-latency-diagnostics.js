function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function cleanOperations(stageTimings = {}) {
  const rows = [];
  for (const [stage, timing] of Object.entries(stageTimings ?? {})) {
    const operations = timing?.operations && typeof timing.operations === 'object'
      ? timing.operations : { [stage]: timing };
    for (const [operation, details] of Object.entries(operations)) {
      rows.push(Object.freeze({
        stage,
        operation,
        durationMs: Math.round(finite(details?.durationMs) * 100) / 100,
        calls: Math.max(0, Math.trunc(finite(details?.calls))),
        cacheHits: Math.max(0, Math.trunc(finite(details?.cacheHits))),
      }));
    }
  }
  return rows;
}

export function summarizeTemplateEngineLatency(stageTimings = {}, turnTiming = {}) {
  const operations = cleanOperations(stageTimings);
  const llmCalls = operations.filter((row) => row.stage === 'generation')
    .reduce((total, row) => total + row.calls - row.cacheHits, 0);
  const repeatedOperations = operations.filter((row) => row.calls > 1)
    .map((row) => Object.freeze({ operation: row.operation,
      calls: row.calls, cacheHits: row.cacheHits, durationMs: row.durationMs }));
  const slowestOperations = [...operations].filter((row) => row.durationMs > 0)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5).map((row) => Object.freeze({ operation: row.operation,
      calls: row.calls, durationMs: row.durationMs }));
  return Object.freeze({
    actualAnswerFirstAudioMs: Number.isFinite(turnTiming.finalAnswerFirstAudioMs)
      ? turnTiming.finalAnswerFirstAudioMs : null,
    acknowledgementFirstAudioMs: Number.isFinite(turnTiming.acknowledgementFirstAudioMs)
      ? turnTiming.acknowledgementFirstAudioMs : null,
    answerAudioStartupMs: Number.isFinite(turnTiming.finalAnswerAudioAfterReadyMs)
      ? turnTiming.finalAnswerAudioAfterReadyMs : null,
    answerQueueAfterReadyMs: Number.isFinite(turnTiming.answerQueueAfterReadyMs)
      ? turnTiming.answerQueueAfterReadyMs : null,
    ttsAudioAfterQueueMs: Number.isFinite(turnTiming.finalAnswerAudioAfterQueuedMs)
      ? turnTiming.finalAnswerAudioAfterQueuedMs : null,
    llmCalls,
    repeatedOperations: Object.freeze(repeatedOperations),
    slowestOperations: Object.freeze(slowestOperations),
  });
}
