import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { RunnerError, assertActive, abortError } from './errors.js';
import { silence, decodePayload, FRAME_BYTES, FRAME_MS, RATE } from './audio.js';
import { mediaUrl } from './session-client.js';

export class MediaClient extends EventEmitter {
  constructor(config, session, { websocketFactory = (url, protocol) => new WebSocket(url, protocol, {
    maxPayload: 65536, perMessageDeflate: false, followRedirects: false,
  }), startupMs = 10000, closeMs = 1500, maximumBufferMs = 10000, now = () => performance.now() } = {}) {
    super(); this.config = config; this.session = session; this.factory = websocketFactory;
    this.startupMs = startupMs; this.closeMs = closeMs; this.maximumBufferMs = maximumBufferMs; this.now = now;
    this.socket = null; this.state = 'idle'; this.input = Buffer.alloc(0); this.playbackUntil = 0;
    this.transcripts = []; this.sequence = new Set(); this.outputFrames = []; this.inputFrames = [];
    this.diagnostics = []; this.checkpoints = new Set(); this.startedAt = 0; this.failure = null; this.lastCompletedSequence = 0; this.runtimeState = null;
  }
  send(value) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new RunnerError('MEDIA_CLOSED', 'Audio connection is closed.');
    if (this.socket.bufferedAmount > 262144) throw new RunnerError('MEDIA_BACKPRESSURE', 'Audio connection exceeded its buffer bound.');
    this.socket.send(JSON.stringify(value));
  }
  fail(error) {
    if (this.failure || this.state === 'closed') return;
    this.failure = error instanceof RunnerError ? error : new RunnerError('MEDIA_FAILED', 'Audio connection failed; private details omitted.');
    this.emit('failure', this.failure); void this.close();
  }
  async connect(signal) {
    assertActive(signal);
    if (this.state !== 'idle') throw new RunnerError('MEDIA_STATE', 'Audio client cannot reconnect.');
    this.state = 'connecting';
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) { this.fail(error); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new RunnerError('MEDIA_START_TIMEOUT', 'Audio readiness timed out.')), this.startupMs);
      this.abort = () => { const error = abortError(); finish(error); this.fail(error); };
      this.signal = signal; signal?.addEventListener('abort', this.abort, { once: true });
      try {
        this.socket = this.factory(mediaUrl(this.config, this.session), this.session.protocol);
        this.socket.on('message', (data, binary) => {
          try {
            if (binary || data.length > 65536) throw new RunnerError('MEDIA_PROTOCOL', 'Unsupported audio message.');
            const event = JSON.parse(data.toString('utf8'));
            if (event.event === 'ready') {
              if (this.state !== 'connecting' || event.callId !== this.session.callId
                || event.mediaFormat?.encoding !== 'audio/x-mulaw' || event.mediaFormat?.sampleRate !== RATE) {
                throw new RunnerError('MEDIA_READY', 'Audio readiness contract does not match the session.');
              }
              this.state = 'ready'; this.startedAt = this.now(); this.playbackUntil = this.now();
              this.startClock(); finish(); this.emit('ready'); return;
            }
            if (this.state !== 'ready') throw new RunnerError('MEDIA_PROTOCOL', 'Audio arrived before readiness.');
            this.handle(event);
          } catch (error) { const safe = error instanceof RunnerError ? error : new RunnerError('MEDIA_PROTOCOL', 'Invalid audio message.'); finish(safe); this.fail(safe); }
        });
        this.socket.on('unexpected-response', (_request, response) => { response.resume(); finish(new RunnerError('MEDIA_UPGRADE', 'Audio upgrade rejected.', { status: response.statusCode })); });
        this.socket.on('error', () => { const error = new RunnerError('MEDIA_UNAVAILABLE', 'Audio connection unavailable.'); finish(error); this.fail(error); });
        this.socket.on('close', () => {
          const intentional = this.state === 'closing';
          if (settled && !intentional && !this.failure) {
            this.failure = new RunnerError('MEDIA_DISCONNECTED', 'Target audio disconnected.'); this.emit('failure', this.failure);
          }
          this.dispose(); this.state = 'closed'; this.emit('closed');
          if (!settled) finish(new RunnerError('MEDIA_EARLY_CLOSE', 'Audio closed before readiness.'));
          
        });
      } catch { finish(new RunnerError('MEDIA_UNAVAILABLE', 'Audio connection could not start.')); }
    });
  }
  startClock() {
    this.nextTick = this.now() + FRAME_MS;
    this.clock = setInterval(() => {
      try {
        if (this.now() - this.startedAt >= this.config.maxDurationSeconds * 1000) {
          this.fail(new RunnerError('DURATION_LIMIT', 'Maximum test duration reached.')); return;
        }
        // Never catch up by sending a burst of late frames.
        const frame = silence();
        if (this.input.length) {
          this.input.copy(frame, 0, 0, FRAME_BYTES);
          this.input = this.input.subarray(Math.min(FRAME_BYTES, this.input.length));
        }
        this.send({ event: 'media', media: { contentType: 'audio/x-mulaw', sampleRate: RATE,
          timestamp: this.now() - this.startedAt, payload: frame.toString('base64') } });
        this.inputFrames.push(frame);
        if (this.input.length === 0) this.emit('inputDrained');
      } catch (error) { this.fail(error); }
    }, FRAME_MS);
  }
  handle(event) {
    if (event.event === 'audio') {
      if (event.media?.contentType !== 'audio/x-mulaw' || event.media.sampleRate !== RATE) throw new RunnerError('MEDIA_FORMAT', 'Target audio format is invalid.');
      const bytes = decodePayload(event.media.payload);
      const next = Math.max(this.now(), this.playbackUntil) + bytes.length / RATE * 1000;
      if (next - this.now() > this.maximumBufferMs) throw new RunnerError('PLAYBACK_BUFFER', 'Target audio queue exceeded its bound.');
      this.playbackUntil = next; this.outputFrames.push(bytes); this.emit('audio', bytes);
    } else if (event.event === 'checkpoint') {
      if (typeof event.name !== 'string' || !event.name || event.name.length > 160 || this.checkpoints.size >= 64) {
        throw new RunnerError('CHECKPOINT_INVALID', 'Target checkpoint is invalid or excessive.');
      }
      const item = { name: event.name, timer: null };
      item.timer = setTimeout(() => {
        this.checkpoints.delete(item);
        if (this.state === 'ready') { try { this.send({ event: 'playedStream', name: item.name }); this.lastCompletedSequence = Math.max(this.lastCompletedSequence, ...this.transcripts.map((line) => line.sequenceNumber)); this.emit('playbackComplete', item.name); } catch (error) { this.fail(error); } }
      }, Math.max(0, this.playbackUntil - this.now()));
      this.checkpoints.add(item);
    } else if (event.event === 'clearAudio') {
      this.clearCheckpoints(); this.playbackUntil = this.now(); this.send({ event: 'clearedAudio' }); this.emit('interruption');
    } else if (event.event === 'diagnostic' && event.diagnostic && typeof event.diagnostic === 'object') {
      if (this.diagnostics.length >= 10000) throw new RunnerError('EVIDENCE_LIMIT', 'Diagnostic bound exceeded.');
      this.diagnostics.push(event.diagnostic);
      const line = event.diagnostic;
      if (line.type === 'state' && typeof line.current === 'string') {
        this.runtimeState = line.current;
        if (line.current === 'listening' && ['greeting_completed', 'playback_completed'].includes(line.reason)) {
          // This engine reports delivery completion through state, not socket checkpoints.
          // Snapshot the speech tail; subsequent ambient audio must not extend this boundary.
          const item = { name: null, timer: null };
          item.timer = setTimeout(() => {
            this.checkpoints.delete(item);
            if (this.state === 'ready') {
              this.lastCompletedSequence = Math.max(this.lastCompletedSequence, ...this.transcripts.map((entry) => entry.sequenceNumber));
              this.emit('playbackComplete', 'runtime-state');
            }
          }, Math.max(0, this.playbackUntil - this.now()));
          this.checkpoints.add(item);
        }
        this.emit('runtimeState', line.current);
      }
      if (line.type === 'transcript' && ['agent', 'user'].includes(line.speaker)
        && Number.isInteger(line.sequenceNumber) && typeof line.text === 'string' && line.text.length <= 16000) {
        if (!this.sequence.has(line.sequenceNumber)) {
          this.sequence.add(line.sequenceNumber); this.transcripts.push(line); this.emit('transcript', line);
        }
      }
      this.emit('diagnostic', line);
    }
  }
  async sendUtterance(bytes, signal) {
    assertActive(signal);
    if (this.state !== 'ready' || !Buffer.isBuffer(bytes) || !bytes.length || this.input.length || bytes.length > 8 * RATE) {
      throw new RunnerError('CALLER_AUDIO', 'Caller utterance is unavailable, queued, or exceeds eight seconds.');
    }
    this.input = Buffer.from(bytes);
    await this.waitUntil(() => !this.input.length, ['inputDrained'], 10000, signal);
  }
  async waitUntil(predicate, events, timeoutMs, signal) {
    assertActive(signal); if (this.failure) throw this.failure; if (predicate()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); for (const event of events) this.off(event, check); this.off('failure', failed); this.off('closed', closed); signal?.removeEventListener('abort', cancelled); };
      const done = (error) => { cleanup(); error ? reject(error) : resolve(); };
      const check = () => { if (predicate()) done(); };
      const failed = (error) => done(error);
      const closed = () => done(new RunnerError('MEDIA_CLOSED', 'Audio connection ended while waiting.'));
      const cancelled = () => done(abortError());
      const timer = setTimeout(() => done(new RunnerError('TURN_TIMEOUT', 'Expected target turn did not finish within its bound.')), timeoutMs);
      for (const event of events) this.on(event, check);
      this.on('failure', failed); this.on('closed', closed); signal?.addEventListener('abort', cancelled, { once: true });
      check();
    });
  }
  async waitForAgentTurn(afterSequence = 0, signal, timeoutMs = 45000) {
    let played = this.lastCompletedSequence > afterSequence;
    const mark = () => { played = true; };
    this.on('playbackComplete', mark);
    try {
      await this.waitUntil(() => played && this.transcripts.some((line) => line.speaker === 'agent' && line.sequenceNumber > afterSequence),
        ['transcript', 'playbackComplete'], timeoutMs, signal);
      return this.transcripts.filter((line) => line.sequenceNumber > afterSequence);
    } finally { this.off('playbackComplete', mark); }
  }
  clearCheckpoints() { for (const item of this.checkpoints) clearTimeout(item.timer); this.checkpoints.clear(); }
  dispose() { clearInterval(this.clock); clearTimeout(this.durationTimer); this.clearCheckpoints(); this.signal?.removeEventListener('abort', this.abort); }
  async close() {
    if (this.state === 'closed') return;
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = (async () => {
      this.state = 'closing'; this.dispose(); this.input = Buffer.alloc(0);
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) { this.state = 'closed'; return; }
      if (this.socket.readyState === WebSocket.OPEN) { try { this.send({ event: 'stop' }); } catch {} }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, this.closeMs);
        this.socket.once('close', () => { clearTimeout(timer); resolve(); });
        this.socket.close(1000, 'runner stopped');
      });
      this.state = 'closed';
    })();
    return this.closingPromise;
  }
}


