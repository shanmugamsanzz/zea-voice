const defaultLog = Object.freeze({
  error() {},
});

export class TranscriptPersistenceQueue {
  #persist;
  #log;
  #tail = Promise.resolve();
  #pending = 0;
  #saved = 0;
  #failed = 0;

  constructor({ persist, log = defaultLog }) {
    if (typeof persist !== 'function') throw new TypeError('Transcript persistence function is required');
    this.#persist = persist;
    this.#log = log;
  }

  enqueue(entry) {
    const snapshot = {
      ...entry,
      sources: Array.isArray(entry.sources) ? entry.sources.map((source) => ({
        ...source,
        metadata: { ...(source.metadata ?? {}) },
      })) : [],
    };
    this.#pending += 1;
    this.#tail = this.#tail
      .then(async () => {
        await this.#persist(snapshot);
        this.#saved += 1;
      })
      .catch((error) => {
        this.#failed += 1;
        this.#log.error({
          err: error,
          stage: 'transcript.persistence_failed',
          callId: snapshot.callId,
          sequenceNumber: snapshot.sequenceNumber,
        }, 'Transcript entry could not be persisted');
      })
      .finally(() => { this.#pending -= 1; });
    return { queued: true, sequenceNumber: snapshot.sequenceNumber };
  }

  async flush() {
    await this.#tail;
    return this.metrics();
  }

  metrics() {
    return Object.freeze({ pending: this.#pending, saved: this.#saved, failed: this.#failed });
  }
}
