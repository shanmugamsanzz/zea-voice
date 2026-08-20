const millisecondsPerMinute = 60_000;

export function configuredCallDurationMs(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * millisecondsPerMinute);
}
