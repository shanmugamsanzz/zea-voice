import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middleware/errors.js';
import { validateVoiceMediaToken } from './plivo-answer.service.js';
import { activeCallSessions, loadVoiceMediaCallSession } from './call-session-store.js';
import { voiceCallOwnership } from './call-ownership.service.js';

const mediaPath = '/webhooks/plivo/media';
const plivoProtocol = 'audio.drachtio.org';
const supportedEncoding = 'audio/x-mulaw';
const supportedSampleRate = 8000;
const dtmfPattern = /^[0-9*#A-D]$/;

function noOp() {}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) return socket.destroy();
  const body = JSON.stringify({ success: false, error: message });
  const status = {
    400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found',
    409: 'Conflict', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
    426: 'Upgrade Required', 500: 'Internal Server Error',
  }[statusCode] ?? 'Bad Request';
  socket.end(
    `HTTP/1.1 ${statusCode} ${status}\r\n`
    + 'Connection: close\r\nContent-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function validBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function sequence(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class PlivoMediaSession extends EventEmitter {
  constructor(options) {
    super();
    this.call = options.call;
    this.callId = options.call.id;
    this.providerCallId = options.call.providerCallId;
    this.socket = options.socket;
    this.log = options.log ?? logger;
    this.idleTimeoutMs = options.idleTimeoutMs ?? env.VOICE_MEDIA_IDLE_TIMEOUT_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? env.VOICE_MEDIA_MAX_MESSAGE_BYTES;
    this.maxPendingMessages = options.maxPendingMessages ?? env.VOICE_MEDIA_MAX_PENDING_MESSAGES;
    this.streamId = null;
    this.mediaFormat = null;
    this.started = false;
    this.closed = false;
    this.lastSequence = -1;
    this.processing = Promise.resolve();
    this.pendingMessages = 0;
    this.onClosed = options.onClosed ?? noOp;
    this.#bind();
  }

  #idleTimer = null;

  #touch() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close(1001, 'media idle timeout'), this.idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #bind() {
    this.socket.on('message', (data, isBinary) => {
      this.#touch();
      this.pendingMessages += 1;
      if (this.pendingMessages > this.maxPendingMessages) {
        this.#fail(new AppError(429, 'Plivo media queue capacity was exceeded', 'VOICE_MEDIA_QUEUE_FULL'));
        return;
      }
      this.processing = this.processing
        .then(() => this.#process(data, isBinary))
        .catch((error) => this.#fail(error))
        .finally(() => { this.pendingMessages = Math.max(0, this.pendingMessages - 1); });
    });
    this.socket.on('close', (code, reason) => this.#finish(code, reason.toString()));
    this.socket.on('error', (error) => {
      this.log.warn({ err: error, callId: this.callId }, 'Plivo media WebSocket error');
    });
    this.#touch();
  }

  async #process(data, isBinary) {
    if (this.closed) return;
    if (isBinary) throw new AppError(400, 'Binary WebSocket messages are not supported', 'VOICE_MEDIA_BINARY_MESSAGE');
    if (data.length > this.maxMessageBytes) {
      throw new AppError(413, 'Plivo media message is too large', 'VOICE_MEDIA_MESSAGE_TOO_LARGE');
    }
    let event;
    try { event = JSON.parse(data.toString('utf8')); } catch {
      throw new AppError(400, 'Plivo media message is not valid JSON', 'VOICE_MEDIA_JSON_INVALID');
    }
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
      throw new AppError(400, 'Plivo media event is invalid', 'VOICE_MEDIA_EVENT_INVALID');
    }
    const currentSequence = sequence(event.sequenceNumber);
    if (currentSequence !== null) {
      if (currentSequence <= this.lastSequence) {
        this.log.warn({ callId: this.callId, sequenceNumber: currentSequence }, 'Stale Plivo media event ignored');
        return;
      }
      this.lastSequence = currentSequence;
    }
    switch (event.event) {
      case 'start': return this.#start(event);
      case 'media': return this.#media(event);
      case 'dtmf': return this.#dtmf(event);
      case 'playedStream': return this.#played(event);
      case 'clearedAudio': return this.#cleared(event);
      case 'stop': return this.#stop(event);
      default:
        this.log.debug({ callId: this.callId, event: event.event }, 'Unsupported Plivo media event ignored');
        return undefined;
    }
  }

  #requireStarted(event) {
    if (!this.started || !this.streamId) {
      throw new AppError(409, `Plivo ${event} event arrived before start`, 'VOICE_MEDIA_NOT_STARTED');
    }
  }

  #requireStream(streamId) {
    if (streamId && streamId !== this.streamId) {
      throw new AppError(409, 'Plivo event stream does not match this call', 'VOICE_MEDIA_STREAM_MISMATCH');
    }
  }

  async #start(event) {
    if (this.started) throw new AppError(409, 'Duplicate Plivo start event', 'VOICE_MEDIA_ALREADY_STARTED');
    const start = event.start ?? {};
    if (!start.streamId || start.callId !== this.providerCallId) {
      throw new AppError(401, 'Plivo start event does not match the authenticated call', 'VOICE_MEDIA_START_MISMATCH');
    }
    const encoding = String(start.mediaFormat?.encoding ?? '').toLowerCase();
    const sampleRate = Number(start.mediaFormat?.sampleRate);
    if (encoding !== supportedEncoding || sampleRate !== supportedSampleRate) {
      throw new AppError(415, 'Plivo media must use audio/x-mulaw at 8000 Hz', 'VOICE_MEDIA_FORMAT_UNSUPPORTED', {
        encoding, sampleRate,
      });
    }
    this.streamId = start.streamId;
    this.mediaFormat = { encoding, sampleRate };
    this.started = true;
    this.log.info({ callId: this.callId, providerCallId: this.providerCallId, streamId: this.streamId }, 'Plivo media stream started');
    this.emit('start', { session: this, event });
  }

  async #media(event) {
    this.#requireStarted('media');
    this.#requireStream(event.streamId);
    const media = event.media ?? {};
    if (media.track && media.track !== 'inbound') return;
    if (!validBase64(media.payload)) {
      throw new AppError(400, 'Plivo media payload is not valid base64 audio', 'VOICE_MEDIA_PAYLOAD_INVALID');
    }
    const audio = Buffer.from(media.payload, 'base64');
    if (!audio.length || audio.length > this.maxMessageBytes) {
      throw new AppError(413, 'Plivo audio chunk has an invalid size', 'VOICE_MEDIA_AUDIO_SIZE_INVALID');
    }
    this.emit('media', {
      session: this, audio, track: media.track ?? 'inbound',
      timestamp: media.timestamp ?? null, chunk: media.chunk ?? null, event,
    });
  }

  async #dtmf(event) {
    this.#requireStarted('dtmf');
    this.#requireStream(event.streamId);
    const digit = String(event.dtmf?.digit ?? '').toUpperCase();
    if (!dtmfPattern.test(digit)) {
      throw new AppError(400, 'Plivo DTMF digit is invalid', 'VOICE_MEDIA_DTMF_INVALID');
    }
    this.emit('dtmf', { session: this, digit, event });
  }

  async #played(event) {
    this.#requireStarted('playedStream');
    this.#requireStream(event.streamId);
    this.emit('playedStream', { session: this, name: event.name ?? null, event });
  }

  async #cleared(event) {
    this.#requireStarted('clearedAudio');
    this.#requireStream(event.streamId);
    this.emit('clearedAudio', { session: this, event });
  }

  async #stop(event) {
    if (this.started) this.#requireStream(event.streamId ?? event.stop?.streamId);
    this.emit('stop', { session: this, event });
    this.close(1000, 'Plivo stream stopped');
  }

  #send(message) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new AppError(409, 'Plivo media WebSocket is not open', 'VOICE_MEDIA_SOCKET_CLOSED');
    }
    this.socket.send(JSON.stringify(message));
  }

  sendAudio(audio, options = {}) {
    this.#requireStarted('playAudio');
    const payload = Buffer.isBuffer(audio) ? audio.toString('base64') : String(audio ?? '');
    if (!validBase64(payload)) throw new TypeError('Synthesized audio must be a non-empty Buffer or base64 string');
    const contentType = options.contentType ?? supportedEncoding;
    const sampleRate = options.sampleRate ?? supportedSampleRate;
    if (contentType !== this.mediaFormat.encoding || sampleRate !== this.mediaFormat.sampleRate) {
      throw new AppError(409, 'Synthesized audio format must match the Plivo stream', 'VOICE_MEDIA_OUTPUT_FORMAT_MISMATCH');
    }
    this.#send({ event: 'playAudio', media: { contentType, sampleRate, payload } });
  }

  checkpoint(name) {
    this.#requireStarted('checkpoint');
    const checkpointName = String(name ?? '').trim();
    if (!checkpointName || checkpointName.length > 160) throw new TypeError('Checkpoint name is required and must not exceed 160 characters');
    this.#send({ event: 'checkpoint', streamId: this.streamId, name: checkpointName });
  }

  clearAudio(reason = 'interruption') {
    this.#requireStarted('clearAudio');
    this.#send({ event: 'clearAudio', streamId: this.streamId });
    this.emit('interruption', { session: this, reason });
  }

  sendDtmf(digits) {
    const value = String(digits ?? '').toUpperCase();
    if (!value || !/^[0-9*#A-D]+$/.test(value)) throw new TypeError('DTMF digits are invalid');
    this.#send({ event: 'sendDTMF', dtmf: value });
  }

  #fail(error) {
    this.log.error({ err: error, callId: this.callId, streamId: this.streamId }, 'Plivo media protocol failed');
    this.emit('failure', { session: this, error });
    const code = error.statusCode === 401 ? 1008 : 1003;
    this.close(code, String(error.code ?? 'media protocol error').slice(0, 123));
  }

  close(code = 1000, reason = 'completed') {
    if (this.closed) return;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, String(reason).slice(0, 123));
    } else {
      this.#finish(code, reason);
    }
  }

  #finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#idleTimer);
    this.onClosed(this);
    this.emit('closed', { session: this, code, reason });
    this.removeAllListeners();
  }
}

export function attachPlivoMediaWebSocket(httpServer, options = {}) {
  const sessionStore = options.sessionStore ?? activeCallSessions;
  const loadCallSession = options.loadCallSession ?? loadVoiceMediaCallSession;
  const validateToken = options.validateToken ?? validateVoiceMediaToken;
  const ownership = options.ownership ?? voiceCallOwnership;
  const log = options.logger ?? logger;
  const sessions = new Set();
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: options.maxMessageBytes ?? env.VOICE_MEDIA_MAX_MESSAGE_BYTES,
    handleProtocols(protocols) { return protocols.has(plivoProtocol) ? plivoProtocol : false; },
  });

  wss.on('connection', (socket, request, authenticated) => {
    let heartbeatTimer;
    const session = new PlivoMediaSession({
      socket,
      call: authenticated.call,
      log: log.child?.({ callId: authenticated.call.id }) ?? log,
      idleTimeoutMs: options.idleTimeoutMs,
      maxMessageBytes: options.maxMessageBytes,
      maxPendingMessages: options.maxPendingMessages,
      onClosed(closedSession) {
        clearInterval(heartbeatTimer);
        sessions.delete(closedSession);
        sessionStore.deleteIf(closedSession.callId, closedSession);
        void ownership.release({
          tenantId: closedSession.call.tenantId,
          providerCallId: closedSession.providerCallId,
        }).catch((error) => log.warn({ err: error, callId: closedSession.callId }, 'Voice call ownership release failed'));
      },
    });
    try {
      sessionStore.add(session.callId, session);
      sessions.add(session);
      heartbeatTimer = setInterval(() => {
        void ownership.heartbeat({
          tenantId: session.call.tenantId, providerCallId: session.providerCallId,
        }).then((owned) => {
          if (!owned) session.close(1012, 'voice call ownership lost');
        }).catch((error) => {
          log.error({ err: error, callId: session.callId }, 'Voice call heartbeat failed');
          session.close(1012, 'voice call heartbeat failed');
        });
      }, options.heartbeatIntervalMs ?? env.VOICE_CALL_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      options.onSession?.(session, authenticated);
    } catch (error) {
      session.close(1008, error.code ?? 'duplicate call session');
    }
  });

  const upgrade = (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://zea-voice.local'); } catch { return rejectUpgrade(socket, 400, 'Invalid WebSocket URL'); }
    if (url.pathname !== mediaPath) return;
    socket.on('error', noOp);
    void (async () => {
      try {
        const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
          .split(',').map((value) => value.trim()).filter(Boolean);
        if (!protocols.includes(plivoProtocol)) {
          throw new AppError(426, 'Plivo media WebSocket protocol is required', 'VOICE_MEDIA_PROTOCOL_REQUIRED');
        }
        const callId = url.searchParams.get('call_id');
        const token = url.searchParams.get('token');
        if (!callId || !token) throw new AppError(401, 'Voice media call token is required', 'VOICE_MEDIA_TOKEN_REQUIRED');
        const tokenPayload = validateToken(token, callId, options.tokenOptions ?? {});
        const call = await loadCallSession(callId);
        if (call.providerCallId !== tokenPayload.providerCallId) {
          throw new AppError(401, 'Voice media token does not match the provider call', 'VOICE_MEDIA_TOKEN_PROVIDER_MISMATCH');
        }
        if (sessionStore.get(callId, { touch: false })) {
          throw new AppError(409, 'A media connection is already active for this call', 'VOICE_MEDIA_ALREADY_CONNECTED');
        }
        await ownership.claimMedia({ tenantId: call.tenantId, providerCallId: call.providerCallId });
        wss.handleUpgrade(request, socket, head, (webSocket) => {
          wss.emit('connection', webSocket, request, { call, tokenPayload });
        });
      } catch (error) {
        log.warn({ code: error.code, callId: url.searchParams.get('call_id') ?? null }, 'Plivo media WebSocket upgrade rejected');
        rejectUpgrade(socket, error.statusCode ?? 500, error.message ?? 'WebSocket upgrade failed');
      }
    })();
  };

  httpServer.on('upgrade', upgrade);
  return {
    wss,
    get sessionCount() { return sessions.size; },
    async close() {
      httpServer.off('upgrade', upgrade);
      for (const session of sessions) {
        session.close(1012, 'server shutting down');
      }
      const deadline = Date.now() + (options.shutdownDrainMs ?? env.VOICE_SHUTDOWN_DRAIN_MS);
      while (sessions.size && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      for (const session of sessions) session.socket.terminate();
      await Promise.race([
        new Promise((resolve) => wss.close(() => resolve())),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
        }),
      ]);
    },
  };
}
