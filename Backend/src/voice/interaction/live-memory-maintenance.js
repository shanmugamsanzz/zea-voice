export class LiveMemoryMaintenanceQueue {
  #tail = Promise.resolve();
  #closed = false;

  constructor({ log, callId } = {}) {
    this.log = log;
    this.callId = callId;
    this.metrics = {
      scheduled: 0, completed: 0, failed: 0, pending: 0,
      totalDurationMs: 0, maximumDurationMs: 0, totalQueueDelayMs: 0,
    };
  }

  schedule(label, operation) {
    if (this.#closed || typeof operation !== 'function') return;
    const queuedAt = performance.now();
    this.metrics.scheduled += 1;
    this.metrics.pending += 1;
    this.#tail = this.#tail.then(() => new Promise((resolve) => setImmediate(resolve))).then(async () => {
      const startedAt = performance.now();
      this.metrics.totalQueueDelayMs += Math.max(0, startedAt - queuedAt);
      try {
        await operation();
        this.metrics.completed += 1;
      } catch (error) {
        this.metrics.failed += 1;
        this.log?.warn?.({ err: error, stage: 'live_memory.background_failed', callId: this.callId, operation: label },
          'Asynchronous live-memory maintenance failed without blocking the call');
      } finally {
        const durationMs = Math.max(0, performance.now() - startedAt);
        this.metrics.totalDurationMs += durationMs;
        this.metrics.maximumDurationMs = Math.max(this.metrics.maximumDurationMs, durationMs);
        this.metrics.pending = Math.max(0, this.metrics.pending - 1);
      }
    });
  }

  snapshot() {
    return Object.freeze({ ...this.metrics });
  }

  async flush() {
    await this.#tail;
  }

  close() {
    this.#closed = true;
  }
}
