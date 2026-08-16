export const voiceLatencyTargets = Object.freeze({
  minimumSamples: 20,
  p50FirstAudioMs: 700,
  p90FirstAudioMs: 1_000,
  p95FirstAudioMs: 1_500,
  retrievalMs: 100,
  rerankHydrationMs: 30,
});

export function percentile(values, ratio) {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function evaluateFirstAudioSlo(samples = [], targets = voiceLatencyTargets) {
  const values = samples.map((sample) => Number(sample?.firstAudioMs ?? sample))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const observed = Object.freeze({
    count: values.length,
    p50: percentile(values, 0.50),
    p90: percentile(values, 0.90),
    p95: percentile(values, 0.95),
  });
  if (values.length < targets.minimumSamples) {
    return Object.freeze({ passed: false, reason: 'insufficient_production_samples', observed, targets });
  }
  const passed = observed.p50 < targets.p50FirstAudioMs
    && observed.p90 < targets.p90FirstAudioMs
    && observed.p95 < targets.p95FirstAudioMs;
  return Object.freeze({
    passed,
    reason: passed ? null : 'first_audio_slo_breached',
    observed,
    targets,
  });
}
