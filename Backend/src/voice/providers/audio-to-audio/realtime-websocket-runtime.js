import { WebSocket } from 'ws';
import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { audioDurationMs, normalizeAudioFormat, resolveModelAudioFormat } from '../../audio/audio-format.js';
import { StreamingAudioConverter } from '../../audio/audio-engine.js';
import { AudioToAudioEventChannel } from './audio-to-audio.interface.js';

export function parameter(parameters, ...names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(parameters ?? {}).find(([key]) => wanted.has(key.toLowerCase()))?.[1];
}

export function setting(settings, ...names) {
  const wanted = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g, '')) && value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function websocketUrl(baseUrl, fallback, path) {
  const url = new URL(baseUrl || fallback);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new AppError(503, 'Realtime audio base URL is invalid', 'AUDIO_TO_AUDIO_BASE_URL_INVALID');
  if ((url.pathname === '/' || !url.pathname) && path) url.pathname = path;
  else if (path && !url.pathname.endsWith(path)) url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  return url;
}

export function realtimeAudioFormats(providerConfig) {
  const inputFormat = resolveModelAudioFormat(providerConfig, 'input');
  const outputFormat = resolveModelAudioFormat(providerConfig, 'output');
  if (inputFormat.channels !== 1 || outputFormat.channels !== 1) {
    throw new AppError(409, 'Realtime Audio models must use mono input and output', 'AUDIO_TO_AUDIO_MONO_REQUIRED');
  }
  return { inputFormat, outputFormat };
}

function retryable(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return /timeout|reset|temporar|unavailable|rate|429|\b50[0234]\b|overflow|capacity/.test(message);
}

function asReason(reason) { return Buffer.isBuffer(reason) ? reason.toString() : String(reason ?? ''); }

function safeConfiguration(configuration, outputFormat) {
  const value = { ...configuration, inputFormat: configuration.inputFormat, outputFormat };
  if (value.endpoint) {
    const url = new URL(value.endpoint);
    for (const key of [...url.searchParams.keys()]) {
      if (/(key|token|secret|signature|credential|authorization)/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    value.endpoint = url.toString();
  }
  delete value.apiKey;
  delete value.authorization;
  return Object.freeze(value);
}

/**
 * Shared lifecycle for provider-native realtime audio WebSockets. Providers own
 * their protocol serializers and parsers; this layer owns connection safety,
 * codec conversion, cancellation, normalized events, reconnects, and metrics.
 */
export function createRealtimeWebSocketAdapter({ providerConfig, runtimeContext = {}, protocol, configuration: suppliedConfiguration = null }) {
  const configuration = suppliedConfiguration ?? protocol.resolveConfiguration(providerConfig);
  const channel = new AudioToAudioEventChannel({ providerId: providerConfig.providerId, modelId: providerConfig.modelId });
  const createWebSocket = runtimeContext.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  const reconnectLimit = Math.max(0, Number(runtimeContext.reconnectLimit ?? 1));
  const sourceFormat = runtimeContext.customerAudioFormat ? normalizeAudioFormat(runtimeContext.customerAudioFormat) : configuration.inputFormat;
  const targetFormat = runtimeContext.agentAudioFormat ? normalizeAudioFormat(runtimeContext.agentAudioFormat) : configuration.outputFormat;
  const inboundConverter = new StreamingAudioConverter(sourceFormat, configuration.inputFormat);
  const outboundConverter = new StreamingAudioConverter(configuration.outputFormat, targetFormat);
  let socket = null;
  let connected = false;
  let closed = false;
  let reconnects = 0;
  let reconnectTimer = null;
  let inputBytes = 0;
  let outputBytes = 0;
  let responseId = null;
  const usageTracker = runtimeContext.usageTracker;

  const publishError = (error, canRetry = retryable(error)) => channel.publish({
    type: 'error', code: error?.code ?? 'AUDIO_TO_AUDIO_PROVIDER_ERROR', message: error?.message ?? String(error), retryable: canRetry,
  });
  const publishUsage = (usage = {}) => {
    const normalizedUsage = {
      audioInputBytes: inputBytes,
      audioOutputBytes: outputBytes,
      audioInputMs: audioDurationMs(inputBytes, configuration.inputFormat),
      audioOutputMs: audioDurationMs(outputBytes, configuration.outputFormat),
      ...usage,
    };
    // Native audio runtimes are optional. When selected, meter them directly
    // under their own provider/model instead of attributing their audio tokens
    // to the separate STT, LLM, or TTS providers.
    usageTracker?.record?.('audio_to_audio', normalizedUsage, providerConfig);
    channel.publish({ type: 'usage', responseId, usage: normalizedUsage });
  };

  function emitProviderEvent(event) {
    if (!event) return;
    if (event.type === 'agent_audio') {
      const audio = Buffer.isBuffer(event.audio) ? event.audio : Buffer.from(event.audio ?? '', 'base64');
      const converted = outboundConverter.push(audio);
      if (!converted.length) return;
      outputBytes += audio.length;
      channel.publish({ type: 'agent_audio', audio: converted, format: targetFormat, responseId: event.responseId ?? responseId });
      return;
    }
    if (event.type === 'response_started') responseId = event.responseId ?? responseId;
    if (event.type === 'response_completed') {
      const trailing = outboundConverter.flush();
      if (trailing.length) channel.publish({ type: 'agent_audio', audio: trailing, format: targetFormat, responseId: event.responseId ?? responseId });
      channel.publish({ type: 'response_completed', responseId: event.responseId ?? responseId, usage: event.usage ?? {} });
      publishUsage(event.usage ?? {});
      responseId = null;
      return;
    }
    if (event.type === 'usage') { publishUsage(event.usage ?? {}); return; }
    channel.publish(event);
  }

  function scheduleReconnect(error) {
    if (closed || reconnectTimer || reconnects >= reconnectLimit) return;
    reconnects += 1;
    publishError(error, true);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((connectionError) => publishError(connectionError, reconnects < reconnectLimit));
    }, Number(runtimeContext.reconnectDelayMs ?? 250));
    reconnectTimer.unref?.();
  }

  async function connect() {
    if (closed) throw new AppError(409, 'Realtime audio adapter is closed', 'AUDIO_TO_AUDIO_ADAPTER_CLOSED');
    if (connected && socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const candidate = createWebSocket(configuration.endpoint, protocol.connectionOptions(configuration));
      socket = candidate;
      const timeout = setTimeout(() => {
        cleanup(); candidate.once('error', () => {}); candidate.terminate?.();
        reject(new AppError(504, `${protocol.name} realtime audio connection timed out`, 'AUDIO_TO_AUDIO_CONNECT_TIMEOUT'));
      }, runtimeContext.connectTimeoutMs ?? env.STT_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
      const cleanup = () => { clearTimeout(timeout); candidate.off('open', onOpen); candidate.off('error', onInitialError); candidate.off('close', onInitialClose); };
      const onOpen = () => {
        cleanup(); connected = true; reconnects = 0;
        candidate.on('message', (raw, isBinary) => {
          try { for (const event of protocol.parseMessage(raw, configuration, isBinary) ?? []) emitProviderEvent(event); }
          catch (error) { publishError(error); }
        });
        candidate.on('error', (error) => publishError(error, true));
        candidate.on('close', (code, reason) => {
          connected = false;
          if (!closed && code !== 1000) scheduleReconnect(new Error(`${protocol.name} realtime audio closed (${code}): ${asReason(reason)}`));
        });
        for (const message of protocol.initialMessages?.(configuration) ?? []) candidate.send(typeof message === 'string' ? message : JSON.stringify(message));
        resolve();
      };
      const onInitialError = (error) => { cleanup(); reject(new AppError(502, `${protocol.name} realtime audio connection failed: ${error.message}`, 'AUDIO_TO_AUDIO_CONNECT_FAILED')); };
      const onInitialClose = (code, reason) => { cleanup(); reject(new AppError(502, `${protocol.name} realtime audio rejected connection (${code}): ${asReason(reason)}`, 'AUDIO_TO_AUDIO_CONNECT_REJECTED')); };
      candidate.once('open', onOpen); candidate.once('error', onInitialError); candidate.once('close', onInitialClose);
    });
  }

  function requireConnection() {
    if (!connected || socket?.readyState !== WebSocket.OPEN) throw new AppError(409, 'Realtime audio WebSocket is not connected', 'AUDIO_TO_AUDIO_NOT_CONNECTED');
  }

  function sendCustomerAudio(audio) {
    requireConnection();
    if (!Buffer.isBuffer(audio) || !audio.length) throw new TypeError('Customer audio must be a non-empty Buffer');
    const converted = inboundConverter.push(audio);
    if (!converted.length) return;
    inputBytes += converted.length;
    for (const message of protocol.audioMessages(converted, configuration) ?? []) {
      socket.send(Buffer.isBuffer(message) || typeof message === 'string' ? message : JSON.stringify(message));
    }
  }

  function cancelResponse(reason = 'barge-in') {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (connected && socket?.readyState === WebSocket.OPEN) {
      for (const message of protocol.cancelMessages?.(reason, configuration) ?? []) socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
    outboundConverter.reset();
    channel.publish({ type: 'cancelled', responseId, reason });
    responseId = null;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connected = false;
    inboundConverter.reset(); outboundConverter.reset();
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, 'closed');
    socket = null;
    channel.close();
  }

  return Object.freeze({
    configuration: safeConfiguration(configuration, targetFormat),
    connect, sendCustomerAudio, cancelResponse, close,
    onEvent: (listener) => channel.subscribe(listener), events: () => channel.iterate(),
  });
}
