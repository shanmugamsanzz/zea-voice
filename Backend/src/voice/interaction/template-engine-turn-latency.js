export const TEMPLATE_ENGINE_TURN_LATENCY_VERSION = 2;

function cleanText(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function resolveConfiguredLatencyAcknowledgement({ configuredText = '' } = {}) {
  return Object.freeze({ text: cleanText(configuredText) });
}

export function latencyAcknowledgementEligibleForRoute({
  decision = '',
} = {}) {
  // Knowledge searches are the only route whose answer-generation work may
  // need progress speech. Workflow collection/confirmation/execution uses the
  // TOOL route; a separate factual question during a paused workflow remains
  // a SEARCH. Direct responses include closing and other conversational turns
  // that must not receive a processing preamble.
  return cleanText(decision, 40).toLocaleUpperCase() === 'SEARCH';
}

export function armTemplateEngineTurnLatencyAcknowledgement({
  thresholdMs,
  acknowledgementText,
  suppressed = false,
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
  let thresholdReached = false;
  const deliver = () => {
    if (cancelled || suppressed || triggered || isActive() !== true) return;
    triggered = true;
    queued = onAcknowledgement(text) === true;
    onTriggered?.(Object.freeze({ thresholdMs: delayMs, queued }));
  };

  if (text && Number.isFinite(delayMs) && delayMs > 0
    && typeof onAcknowledgement === 'function') {
    timer = setTimer(() => {
      timer = null;
      thresholdReached = true;
      deliver();
    }, delayMs);
    timer?.unref?.();
  }

  return Object.freeze({
    setSuppressed(value) {
      suppressed = value === true;
      if (!suppressed && thresholdReached) deliver();
    },
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
        suppressed,
      });
    },
  });
}
