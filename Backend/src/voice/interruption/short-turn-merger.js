function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function appendWithOverlap(left, right) {
  const existing = normalize(left);
  const incoming = normalize(right);
  if (!existing) return incoming;
  if (!incoming) return existing;
  const lowerExisting = existing.toLocaleLowerCase();
  const lowerIncoming = incoming.toLocaleLowerCase();
  if (lowerIncoming.startsWith(lowerExisting)) return incoming;
  if (lowerExisting.endsWith(lowerIncoming)) return existing;
  return `${existing} ${incoming}`.trim();
}

// Some streaming STT providers finalise very short fragments independently.
// Hold only rejected short/incomplete fragments briefly and join the next
// final result. This never sends audio frames to the LLM.
export class ShortTurnMerger {
  constructor({ windowMs = 1200, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.clear();
  }

  combine(text) {
    const incoming = normalize(text);
    if (!this.pending || this.now() > this.pending.expiresAt) {
      this.clear();
      return incoming;
    }
    const combined = appendWithOverlap(this.pending.text, incoming);
    this.clear();
    return combined;
  }

  defer(text, confidence = null) {
    const normalized = normalize(text);
    if (!normalized) return;
    this.pending = {
      text: normalized,
      confidence,
      expiresAt: this.now() + this.windowMs,
    };
  }

  clear() { this.pending = null; }
}
