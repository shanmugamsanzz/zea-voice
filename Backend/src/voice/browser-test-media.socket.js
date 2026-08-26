import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errors.js';
import { activeCallSessions } from './call-session-store.js';
import { validateBrowserTestMediaToken } from './browser-test-token.js';
import {
  claimBrowserTestMediaSession,
  finalizeBrowserTestBilling,
} from './browser-test-session.service.js';
import { attachRealtimeConversationOrchestrator } from './realtime-conversation-orchestrator.js';

const mediaPath = '/voice/browser-test/media';
const browserProtocol = 'zea.browser-voice.v1';
const supportedEncoding = 'audio/x-mulaw';
const supportedSampleRate = 8000;
const dtmfPattern = /^[0-9*#A-D]$/;

function noOp() {}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) return socket.destroy();
  const body = JSON.stringify({ success: false, error: message });
  const status = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found',
    409: 'Conflict', 413: 'Payload Too Large', 426: 'Upgrade Required',
    429: 'Too Many Requests', 500: 'Internal Server Error' }[statusCode] ?? 'Bad Request';
  socket.end(`HTTP/1.1 ${statusCode} ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function validBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function sendSocket(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new AppError(409, 'Browser test media WebSocket is not open',
      'BROWSER_TEST_MEDIA_SOCKET_CLOSED');
  }
  const startedAt = performance.now();
  const serialized = JSON.stringify(message);
  if (socket.send.length < 2) {
    socket.send(serialized);
    return Promise.resolve({ deliveryMs: performance.now() - startedAt,
      bufferedAmountBefore: 0, bufferedAmountAfter: Number(socket.bufferedAmount ?? 0) });
  }
  const bufferedAmountBefore = Number(socket.bufferedAmount ?? 0);
  return new Promise((resolve, reject) => socket.send(serialized, (error) => {
    if (error) return reject(new AppError(502, 'Browser test audio delivery failed',
      'BROWSER_TEST_MEDIA_SEND_FAILED', { cause: error.message }));
    resolve({ deliveryMs: performance.now() - startedAt, bufferedAmountBefore,
      bufferedAmountAfter: Number(socket.bufferedAmount ?? 0) });
  }));
}

export class BrowserTestMediaSession extends EventEmitter {
  constructor(options) {
    super();
    this.transport = 'browser_test';
    this.call = options.call;
    this.callId = options.call.id;
    this.providerCallId = options.call.providerCallId;
    this.socket = options.socket;
    this.log = options.log ?? logger;
    this.mediaFormat = Object.freeze({ encoding: supportedEncoding, sampleRate: supportedSampleRate });
    this.streamId = `browser-${this.callId}`;
    this.started = false;
    this.closed = false;
    this.maxMessageBytes = options.maxMessageBytes ?? env.VOICE_MEDIA_MAX_MESSAGE_BYTES;
    this.maxPendingMessages = options.maxPendingMessages ?? env.VOICE_MEDIA_MAX_PENDING_MESSAGES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? env.VOICE_MEDIA_IDLE_TIMEOUT_MS;
    this.maximumSessionMs = options.maximumSessionMs
      ?? env.BROWSER_TEST_SESSION_MAX_SECONDS * 1000;
    this.onClosed = options.onClosed ?? noOp;
    this.processing = Promise.resolve();
    this.pendingMessages = 0;
    this.#bind();
  }

  #idleTimer = null;
  #maximumTimer = null;

  #touch() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close(1001, 'browser media idle timeout'),
      this.idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #bind() {
    this.socket.on('message', (data, isBinary) => {
      this.#touch();
      this.pendingMessages += 1;
      if (this.pendingMessages > this.maxPendingMessages) {
        this.#fail(new AppError(429, 'Browser media queue capacity was exceeded',
          'BROWSER_TEST_MEDIA_QUEUE_FULL'));
        return;
      }
      this.processing = this.processing.then(() => this.#process(data, isBinary))
        .catch((error) => this.#fail(error))
        .finally(() => { this.pendingMessages = Math.max(0, this.pendingMessages - 1); });
    });
    this.socket.on('close', (code, reason) => this.#finish(code, reason.toString()));
    this.socket.on('error', (error) => this.log.warn({ err: error, callId: this.callId },
      'Browser test media WebSocket error'));
    this.#maximumTimer = setTimeout(() => this.close(1000, 'browser test maximum duration reached'),
      this.maximumSessionMs);
    this.#maximumTimer.unref?.();
    this.#touch();
  }

  accept() {
    if (this.closed || this.started) return;
    this.started = true;
    void sendSocket(this.socket, { event: 'ready', callId: this.callId,
      streamId: this.streamId, mediaFormat: this.mediaFormat });
    this.emit('start', { session: this, event: { event: 'start', browserTest: true } });
  }

  async #process(data, isBinary) {
    if (this.closed) return;
    if (isBinary) throw new AppError(400, 'Binary browser media messages are not supported',
      'BROWSER_TEST_MEDIA_BINARY_MESSAGE');
    if (data.length > this.maxMessageBytes) {
      throw new AppError(413, 'Browser media message is too large',
        'BROWSER_TEST_MEDIA_MESSAGE_TOO_LARGE');
    }
    let event;
    try { event = JSON.parse(data.toString('utf8')); } catch {
      throw new AppError(400, 'Browser media message is not valid JSON',
        'BROWSER_TEST_MEDIA_JSON_INVALID');
    }
    if (!this.started) throw new AppError(409, 'Browser media session has not started',
      'BROWSER_TEST_MEDIA_NOT_STARTED');
    if (event.event === 'media') {
      const payload = event.media?.payload;
      if (!validBase64(payload)) throw new AppError(400, 'Browser audio is not valid base64',
        'BROWSER_TEST_MEDIA_PAYLOAD_INVALID');
      const audio = Buffer.from(payload, 'base64');
      if (!audio.length || audio.length > this.maxMessageBytes) {
        throw new AppError(413, 'Browser audio chunk has an invalid size',
          'BROWSER_TEST_MEDIA_AUDIO_SIZE_INVALID');
      }
      this.emit('media', { session: this, audio, track: 'inbound',
        timestamp: event.media?.timestamp ?? null, event });
      return;
    }
    if (event.event === 'playedStream') {
      this.emit('playedStream', { session: this, name: event.name ?? null, event });
      return;
    }
    if (event.event === 'clearedAudio') {
      this.emit('clearedAudio', { session: this, event });
      return;
    }
    if (event.event === 'dtmf') {
      const digit = String(event.dtmf?.digit ?? '').toUpperCase();
      if (!dtmfPattern.test(digit)) throw new AppError(400, 'Browser DTMF digit is invalid',
        'BROWSER_TEST_DTMF_INVALID');
      this.emit('dtmf', { session: this, digit, event });
      return;
    }
    if (event.event === 'stop') {
      this.emit('stop', { session: this, event });
      this.close(1000, 'browser stream stopped');
      return;
    }
    this.log.debug({ callId: this.callId, event: event.event },
      'Unsupported browser media event ignored');
  }

  sendAudio(audio, options = {}) {
    const payload = Buffer.isBuffer(audio) ? audio.toString('base64') : String(audio ?? '');
    if (!validBase64(payload)) throw new TypeError('Synthesized audio must be non-empty');
    const contentType = options.contentType ?? supportedEncoding;
    const sampleRate = options.sampleRate ?? supportedSampleRate;
    if (contentType !== supportedEncoding || sampleRate !== supportedSampleRate) {
      throw new AppError(409, 'Synthesized audio format must match browser test media',
        'BROWSER_TEST_MEDIA_OUTPUT_FORMAT_MISMATCH');
    }
    return sendSocket(this.socket, { event: 'audio', media: { contentType, sampleRate, payload } });
  }

  checkpoint(name) {
    const value = String(name ?? '').trim();
    if (!value || value.length > 160) throw new TypeError('Checkpoint name is invalid');
    void sendSocket(this.socket, { event: 'checkpoint', name: value });
  }

  clearAudio(reason = 'interruption') {
    void sendSocket(this.socket, { event: 'clearAudio', reason });
    this.emit('interruption', { session: this, reason });
  }

  sendDtmf(digits) {
    const value = String(digits ?? '').toUpperCase();
    if (!value || !/^[0-9*#A-D]+$/.test(value)) throw new TypeError('DTMF digits are invalid');
    void sendSocket(this.socket, { event: 'sendDTMF', dtmf: value });
  }

  sendDiagnostic(type, details = {}) {
    const diagnosticType = String(type ?? '').trim();
    if (!diagnosticType || diagnosticType.length > 80) return Promise.resolve(null);
    return sendSocket(this.socket, {
      event: 'diagnostic',
      diagnostic: { type: diagnosticType, at: new Date().toISOString(), ...details },
    });
  }

  #fail(error) {
    this.log.error({ err: error, callId: this.callId }, 'Browser test media protocol failed');
    this.emit('failure', { session: this, error });
    this.close(error.statusCode === 401 ? 1008 : 1003,
      String(error.code ?? 'browser media protocol error').slice(0, 123));
  }

  close(code = 1000, reason = 'completed') {
    if (this.closed) return;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, String(reason).slice(0, 123));
    } else this.#finish(code, reason);
  }

  #finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#maximumTimer);
    this.onClosed(this);
    this.emit('closed', { session: this, code, reason });
    this.removeAllListeners();
  }
}

export function attachBrowserTestMediaWebSocket(httpServer, options = {}) {
  const log = options.logger ?? logger;
  const sessionStore = options.sessionStore ?? activeCallSessions;
  const validateToken = options.validateToken ?? validateBrowserTestMediaToken;
  const claimSession = options.claimSession ?? claimBrowserTestMediaSession;
  const attachOrchestrator = options.attachOrchestrator ?? attachRealtimeConversationOrchestrator;
  const sessions = new Set();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false,
    perMessageDeflate: false,
    maxPayload: options.maxMessageBytes ?? env.VOICE_MEDIA_MAX_MESSAGE_BYTES,
    handleProtocols: (protocols) => protocols.has(browserProtocol) ? browserProtocol : false });

  wss.on('connection', (socket, request, authenticated) => {
    const session = new BrowserTestMediaSession({ socket, call: authenticated.call,
      log: log.child?.({ callId: authenticated.call.id, transport: 'browser_test' }) ?? log,
      maxMessageBytes: options.maxMessageBytes, maxPendingMessages: options.maxPendingMessages,
      idleTimeoutMs: options.idleTimeoutMs, maximumSessionMs: options.maximumSessionMs,
      onClosed: (closed) => { sessions.delete(closed); sessionStore.deleteIf(closed.callId, closed); } });
    try {
      sessionStore.add(session.callId, session);
      sessions.add(session);
      attachOrchestrator(session, {
        ...(options.orchestratorDependencies ?? {}),
        completionDependencies: {
          ...(options.orchestratorDependencies?.completionDependencies ?? {}),
          finalizeCreditBilling: options.finalizeBilling ?? finalizeBrowserTestBilling,
        },
      });
      queueMicrotask(() => session.accept());
    } catch (error) {
      session.close(1011, error.code ?? 'browser test startup failed');
    }
  });

  const upgrade = (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://zea-voice.local'); } catch {
      return rejectUpgrade(socket, 400, 'Invalid WebSocket URL');
    }
    if (url.pathname !== mediaPath) return;
    socket.on('error', noOp);
    void (async () => {
      try {
        const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
          .split(',').map((value) => value.trim()).filter(Boolean);
        if (!protocols.includes(browserProtocol)) {
          throw new AppError(426, 'Browser test WebSocket protocol is required',
            'BROWSER_TEST_MEDIA_PROTOCOL_REQUIRED');
        }
        const callId = url.searchParams.get('call_id');
        const token = url.searchParams.get('token');
        if (!callId || !token) throw new AppError(401, 'Browser test call token is required',
          'BROWSER_TEST_MEDIA_TOKEN_REQUIRED');
        const claims = validateToken(token, callId, options.tokenOptions ?? {});
        if (claims.callId !== claims.testCallId) throw new AppError(401,
          'Browser test token call identity is invalid', 'BROWSER_TEST_TOKEN_INVALID');
        if (sessionStore.get(callId, { touch: false })) throw new AppError(409,
          'Browser test media is already connected', 'BROWSER_TEST_MEDIA_ALREADY_CONNECTED');
        const call = await claimSession(callId, claims, options.claimDependencies ?? {});
        wss.handleUpgrade(request, socket, head,
          (webSocket) => wss.emit('connection', webSocket, request, { call, claims }));
      } catch (error) {
        log.warn({ code: error.code, callId: url.searchParams.get('call_id') ?? null },
          'Browser test media WebSocket upgrade rejected');
        rejectUpgrade(socket, error.statusCode ?? 500, error.message ?? 'WebSocket upgrade failed');
      }
    })();
  };
  httpServer.on('upgrade', upgrade);
  return { wss, get sessionCount() { return sessions.size; }, async close() {
    httpServer.off('upgrade', upgrade);
    for (const session of sessions) session.close(1012, 'server shutting down');
    const deadline = Date.now() + (options.shutdownDrainMs ?? env.VOICE_SHUTDOWN_DRAIN_MS);
    while (sessions.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const session of sessions) session.socket.terminate();
    await Promise.race([new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve) => { const timer = setTimeout(resolve, 1000); timer.unref?.(); })]);
  } };
}
