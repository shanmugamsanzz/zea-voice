export const UNIVERSAL_TURN_LATENCY_BUDGET = Object.freeze({
  totalFirstAudioMs: 3_000,
  retrievalMs: 150,
  llmFirstSentenceMs: 2_200,
  ttsFirstAudioMs: 500,
});

export function remainingUniversalTurnBudget(deadlineAt, now = Date.now()) {
  return Math.max(0, Math.floor(Number(deadlineAt) - Number(now)));
}

export function universalStageDeadline({ turnDeadlineAt, maximumMs, reserveMs = 0,
  now = Date.now() } = {}) {
  const stageMaximum = Math.max(1, Number(maximumMs) || 1);
  const shared = Number.isFinite(Number(turnDeadlineAt))
    ? remainingUniversalTurnBudget(turnDeadlineAt, now) - Math.max(0, Number(reserveMs) || 0)
    : stageMaximum;
  return Number(now) + Math.max(1, Math.min(stageMaximum, shared));
}
