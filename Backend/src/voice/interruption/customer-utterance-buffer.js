function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function comparison(value) {
  return normalize(value).toLocaleLowerCase();
}

function overlappingAppend(left, right) {
  const existing = normalize(left);
  const incoming = normalize(right);
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingComparable = comparison(existing);
  const incomingComparable = comparison(incoming);
  if (incomingComparable.startsWith(existingComparable)) return incoming;
  if (existingComparable.startsWith(incomingComparable)) return existing;

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (comparison(existing.slice(-length)) === comparison(incoming.slice(0, length))) {
      return `${existing}${incoming.slice(length)}`.trim();
    }
  }
  return `${existing} ${incoming}`.trim();
}

// Provider-neutral buffer that supports both cumulative partial transcripts
// (each event repeats the turn so far) and incremental partial transcripts.
export class CustomerUtteranceBuffer {
  constructor() { this.reset(); }

  start() {
    this.reset();
    this.started = true;
  }

  observePartial(text) {
    if (!this.started) this.start();
    this.partialText = overlappingAppend(this.partialText, text);
    return this.snapshot();
  }

  observeFinal(text, confidence = null) {
    if (!this.started) this.start();
    this.finalText = overlappingAppend(this.partialText, text);
    this.finalConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
    return this.snapshot();
  }

  markSpeechEnded() {
    this.speechEnded = true;
    return this.snapshot();
  }

  get ready() { return this.speechEnded && Boolean(this.finalText) && !this.finalProcessed; }

  markFinalProcessed() {
    if (!this.ready) return false;
    this.finalProcessed = true;
    return true;
  }

  get text() { return this.finalText || this.partialText; }

  reset() {
    this.started = false;
    this.partialText = '';
    this.finalText = '';
    this.finalConfidence = null;
    this.speechEnded = false;
    this.finalProcessed = false;
  }

  snapshot() {
    return Object.freeze({
      started: this.started,
      partialText: this.partialText,
      finalText: this.finalText,
      finalConfidence: this.finalConfidence,
      speechEnded: this.speechEnded,
      ready: this.ready,
      text: this.text,
    });
  }
}
