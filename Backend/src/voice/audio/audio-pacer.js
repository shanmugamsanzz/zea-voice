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
    this.shouldSend = options.shouldSend ?? (() => true);
    this.onPlaybackMetric = options.onPlaybackMetric ?? (() => {});
    this.underrunThresholdMs = options.underrunThresholdMs ?? 40;
    this.packetDurationMs = options.packetDurationMs ?? 80;
    this.preRollMs = options.preRollMs ?? 120;
    this.preRollMaxWaitMs = options.preRollMaxWaitMs ?? 80;
    this.lowWaterMs = options.lowWaterMs ?? 60;
    this.deliveryLeadMs = options.deliveryLeadMs ?? 160;
    this.websocketWarnMs = options.websocketWarnMs ?? 40;
    this.websocketBufferWarnBytes = options.websocketBufferWarnBytes ?? 262_144;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? delay;
    this.running = false;
    this.sending = false;
    this.pending = false;
    this.controller = null;
    this.runPromise = null;
    this.drainWaiters = [];
    this.lastSentFrame = null;
    this.remotePlaybackEndAt = 0;
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
      this.pending = false;
      this.#resolveDrains();
    });
    return this.runPromise;
  }

  async #run(signal) {
    while (!signal.aborted) {
      const firstFrame = await this.#nextSendable(signal);
      if (!firstFrame) break;
      this.pending = true;
      const receivedAt = this.now();
      const remoteBufferedMs = Math.max(0, this.remotePlaybackEndAt - receivedAt);
      const newPlaybackGroup = !this.lastSentFrame
        || this.lastSentFrame.playbackGroupId !== firstFrame.playbackGroupId;
      const sentenceBoundary = Boolean(this.lastSentFrame)
        && this.lastSentFrame.playbackGroupId === firstFrame.playbackGroupId
        && this.lastSentFrame.generationId !== firstFrame.generationId;
      // Once remote playback has already drained, waiting for more local audio
      // only makes an existing gap longer. Refill while Plivo still has a
      // small lead; otherwise send the recovered sentence immediately.
      const requiresPreRoll = newPlaybackGroup
        || (remoteBufferedMs > 0 && remoteBufferedMs <= this.lowWaterMs);
      const targetPreRollMs = sentenceBoundary
        ? Math.max(this.preRollMs, this.packetDurationMs + this.lowWaterMs)
        : this.preRollMs;
      if (requiresPreRoll && this.preRollMaxWaitMs > 0
        && targetPreRollMs > firstFrame.durationMs) {
        const waitStartedAt = this.now();
        await this.queue.waitForBufferedMs(targetPreRollMs - firstFrame.durationMs, {
          signal, timeoutMs: this.preRollMaxWaitMs,
        });
        this.onPlaybackMetric({
          type: newPlaybackGroup ? 'playback_pre_roll' : 'playback_refill',
          waitMs: Math.max(0, this.now() - waitStartedAt),
          bufferedAudioMs: firstFrame.durationMs + this.queue.bufferedMs,
          targetBufferedAudioMs: targetPreRollMs,
          sentenceBoundary,
          playbackGroupId: firstFrame.playbackGroupId,
        });
      }

      const frame = this.#buildPacket(firstFrame);
      const beforePacing = this.now();
      const bufferedBeforeSend = Math.max(0, this.remotePlaybackEndAt - beforePacing);
      const continuesCurrentGroup = Boolean(this.lastSentFrame)
        && this.lastSentFrame.playbackGroupId === frame.playbackGroupId;
      const pacingWaitMs = continuesCurrentGroup
        ? Math.max(0, bufferedBeforeSend - this.deliveryLeadMs)
        : 0;
      const sendDeadline = beforePacing + pacingWaitMs;
      if (pacingWaitMs > 0) await this.sleep(pacingWaitMs, signal);
      if (signal.aborted) break;
      if (!this.shouldSend(frame)) {
        this.pending = false;
        this.#resolveDrains();
        continue;
      }
      const sendingAt = this.now();
      const actualGapMs = Math.max(0, sendingAt - this.remotePlaybackEndAt);
      const schedulingDelayMs = Math.max(0, sendingAt - sendDeadline);
      if (this.lastSentFrame?.playbackGroupId
        && this.lastSentFrame.playbackGroupId === frame.playbackGroupId) {
        const sentenceBoundary = this.lastSentFrame.generationId !== frame.generationId;
        if (actualGapMs > 0) {
          this.onPlaybackMetric({
            type: 'underrun',
            gapMs: actualGapMs,
            sentenceBoundary,
            playbackGroupId: frame.playbackGroupId,
            fromGenerationId: this.lastSentFrame.generationId,
            toGenerationId: frame.generationId,
            bufferedAudioMs: this.queue.bufferedMs,
          });
        } else if (schedulingDelayMs >= this.underrunThresholdMs) {
          this.onPlaybackMetric({
            type: 'playback_deadline_miss', gapMs: schedulingDelayMs,
            sentenceBoundary, playbackGroupId: frame.playbackGroupId,
            fromGenerationId: this.lastSentFrame.generationId,
            toGenerationId: frame.generationId,
            bufferedAudioMs: this.queue.bufferedMs,
            remoteBufferedAudioMs: Math.max(0, this.remotePlaybackEndAt - sendingAt),
          });
        } else if (sentenceBoundary) {
          this.onPlaybackMetric({
            type: 'sentence_boundary', gapMs: 0, sentenceBoundary: true,
            playbackGroupId: frame.playbackGroupId,
            fromGenerationId: this.lastSentFrame.generationId,
            toGenerationId: frame.generationId,
            bufferedAudioMs: this.queue.bufferedMs,
          });
        }
      }
      this.sending = true;
      const deliveryStartedAt = this.now();
      const transport = await this.send(frame);
      const measuredDeliveryMs = Math.max(0, this.now() - deliveryStartedAt);
      const deliveryMs = Math.max(0, Number(transport?.deliveryMs ?? measuredDeliveryMs));
      const bufferedAmount = Math.max(0, Number(
        transport?.bufferedAmountAfter ?? transport?.bufferedAmountBefore ?? 0,
      ));
      this.onPlaybackMetric({
        type: 'websocket_delivery',
        deliveryMs,
        bufferedAmount,
        slow: deliveryMs >= this.websocketWarnMs,
        backpressured: bufferedAmount >= this.websocketBufferWarnBytes,
        packetDurationMs: frame.durationMs,
        packetBytes: frame.data.length,
        packetFrameCount: Number(frame.packetFrameCount ?? 1),
        playbackGroupId: frame.playbackGroupId,
      });
      this.sending = false;
      this.lastSentFrame = { ...frame, sentAt: sendingAt };
      this.remotePlaybackEndAt = Math.max(this.remotePlaybackEndAt, sendingAt) + frame.durationMs;
      this.pending = false;
      this.#resolveDrains();
    }
  }

  async #nextSendable(signal) {
    while (!signal.aborted) {
      const frame = await this.queue.dequeue({ signal });
      if (!frame || this.shouldSend(frame)) return frame;
      this.#resolveDrains();
    }
    return null;
  }

  #buildPacket(firstFrame) {
    const frames = [firstFrame];
    let durationMs = firstFrame.durationMs;
    let lastFrame = firstFrame;
    while (durationMs < this.packetDurationMs) {
      const candidate = this.queue.peek?.();
      if (!candidate) break;
      if (candidate.playbackGroupId !== firstFrame.playbackGroupId
        || candidate.cancellationVersion !== firstFrame.cancellationVersion) break;
      const next = this.queue.tryDequeue();
      if (!this.shouldSend(next)) continue;
      frames.push(next);
      lastFrame = next;
      durationMs += next.durationMs;
    }
    return {
      ...firstFrame,
      data: frames.length === 1 ? firstFrame.data : Buffer.concat(frames.map(({ data }) => data)),
      durationMs,
      generationId: lastFrame.generationId,
      packetFrameCount: frames.length,
      firstGenerationId: firstFrame.generationId,
    };
  }

  drain() {
    if (this.queue.size === 0 && !this.sending && !this.pending) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  resetPlaybackTimeline() {
    this.remotePlaybackEndAt = 0;
    this.lastSentFrame = null;
  }

  #resolveDrains() {
    if (this.queue.size || this.sending || this.pending) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  async stop() {
    this.controller?.abort(new Error('Audio pacer stopped'));
    await this.runPromise;
  }
}
