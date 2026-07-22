function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(signal.reason ?? new Error('Audio pacing cancelled'));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AudioPacer {
  constructor(options) {
    if (!options?.queue || typeof options.send !== 'function') {
      throw new TypeError('AudioPacer requires a queue and send function');
    }
    this.queue = options.queue;
    this.send = options.send;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? delay;
    this.running = false;
    this.sending = false;
    this.controller = null;
    this.runPromise = null;
    this.drainWaiters = [];
  }

  start() {
    if (this.running) return this.runPromise;
    this.running = true;
    this.controller = new AbortController();
    this.runPromise = this.#run(this.controller.signal).catch((error) => {
      if (!this.controller.signal.aborted) this.onError(error);
    }).finally(() => {
      this.running = false;
      this.sending = false;
      this.#resolveDrains();
    });
    return this.runPromise;
  }

  async #run(signal) {
    let deadline = this.now();
    while (!signal.aborted) {
      const frame = await this.queue.dequeue({ signal });
      if (!frame) break;
      const waitMs = deadline - this.now();
      if (waitMs > 0) await this.sleep(waitMs, signal);
      if (signal.aborted) break;
      this.sending = true;
      await this.send(frame);
      this.sending = false;
      deadline = Math.max(deadline + frame.durationMs, this.now());
      this.#resolveDrains();
    }
  }

  drain() {
    if (this.queue.size === 0 && !this.sending) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  #resolveDrains() {
    if (this.queue.size || this.sending) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  async stop() {
    this.controller?.abort(new Error('Audio pacer stopped'));
    await this.runPromise;
  }
}
