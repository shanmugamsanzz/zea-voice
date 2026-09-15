export function percentile(values, ratio) {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function summarizeFirstAudioLatency(samples = []) {
  const values = samples.map((sample) => Number(sample?.firstAudioMs ?? sample))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return Object.freeze({
    count: values.length,
    p50: percentile(values, 0.50),
    p90: percentile(values, 0.90),
    p95: percentile(values, 0.95),
  });
}
