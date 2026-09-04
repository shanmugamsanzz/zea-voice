export const TEMPLATE_ENGINE_TURN_LATENCY_VERSION = 2;

function cleanText(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function armTemplateEngineTurnLatencyAcknowledgement({
  thresholdMs,
  acknowledgementText,
  isActive = () => true,
  onAcknowledgement,
  onTriggered,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const text = cleanText(acknowledgementText);
  const delayMs = Number(thresholdMs);
  let timer = null;
  let cancelled = false;
  let triggered = false;
  let queued = false;

  if (text && Number.isFinite(delayMs) && delayMs > 0
    && typeof onAcknowledgement === 'function') {
    timer = setTimer(() => {
      timer = null;
      if (cancelled || isActive() !== true) return;
      triggered = true;
      queued = onAcknowledgement(text) === true;
      onTriggered?.(Object.freeze({ thresholdMs: delayMs, queued }));
    }, delayMs);
    timer?.unref?.();
  }

  return Object.freeze({
    cancel() {
      if (cancelled) return false;
      cancelled = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      return true;
    },
    snapshot() {
      return Object.freeze({
        enabled: Boolean(text && Number.isFinite(delayMs) && delayMs > 0),
        thresholdMs: Number.isFinite(delayMs) ? delayMs : null,
        cancelled,
        triggered,
        queued,
      });
    },
  });
}
