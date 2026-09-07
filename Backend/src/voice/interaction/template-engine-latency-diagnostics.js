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

const llmStages = new Set(['routing', 'generation', 'validation']);

// Diagnostic labels describe observed work only. They do not decide whether a
// call was necessary and therefore cannot alter routing, grounding or tools.
export function summarizeTemplateEngineLatency(stageTimings = {}, turnTiming = {}) {
  const operations = cleanOperations(stageTimings);
  const llmCalls = operations.filter((row) => llmStages.has(row.stage))
    .reduce((total, row) => total + row.calls - row.cacheHits, 0);
  const reviewCalls = operations.filter((row) => row.operation.includes('review'))
    .reduce((total, row) => total + row.calls - row.cacheHits, 0);
  const repairCalls = operations.filter((row) => /(?:repair|reroute|retry)/u.test(row.operation))
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
    llmCalls, reviewCalls, repairCalls,
    repeatedOperations: Object.freeze(repeatedOperations),
    slowestOperations: Object.freeze(slowestOperations),
  });
}
