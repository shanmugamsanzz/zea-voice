import { WebSocket } from 'ws';
import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { audioDurationMs, resolveModelAudioFormat } from '../../audio/audio-format.js';
import { SttEventChannel } from './stt.interface.js';

function parameter(parameters, ...names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(parameters ?? {}).find(([key]) => wanted.has(key.toLowerCase()))?.[1];
}

function setting(settings, ...names) {
  const wanted = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(settings ?? {})) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.includes(normalized) && value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function endpoint(baseUrl) {
  const url = new URL(baseUrl || 'https://api.cartesia.ai');
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new AppError(503, 'Cartesia STT base URL is invalid', 'STT_BASE_URL_INVALID');
  if (url.pathname === '/' || !url.pathname) url.pathname = '/stt/websocket';
  else if (!url.pathname.endsWith('/stt/websocket')) url.pathname = `${url.pathname.replace(/\/$/, '')}/stt/websocket`;
  return url;
}

function language(value) {
  const candidate = String(value ?? '').trim();
  return candidate ? candidate.split(/[-_]/)[0].toLowerCase() : 'en';
}

function cartesiaEncoding(format) {
  if (format.channels !== 1 || format.encoding !== 'pcm_s16le') {
    throw new AppError(409, 'Cartesia STT requires mono pcm_s16le input audio', 'STT_AUDIO_FORMAT_UNSUPPORTED');
  }
  return 'pcm_s16le';
}

export function resolveCartesiaSttConfiguration(providerConfig) {
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  const audioFormat = resolveModelAudioFormat(providerConfig, 'input');
  const apiKey = parameter(providerConfig.parameters, 'CARTESIA_API_KEY', 'X_API_KEY', 'API_KEY');
  const accessToken = parameter(providerConfig.parameters, 'CARTESIA_ACCESS_TOKEN', 'ACCESS_TOKEN');
  if (!apiKey && !accessToken) throw new AppError(503, 'Selected Cartesia STT provider has no credential', 'STT_API_KEY_MISSING');
  const url = endpoint(providerConfig.baseUrl);
  const version = parameter(providerConfig.parameters, 'CARTESIA_VERSION', 'API_VERSION') ?? '2026-03-01';
  const model = String(providerConfig.modelKey || 'ink-whisper');
  const selectedLanguage = language(setting(settings, 'sttLanguage', 'languageCode', 'language'));
  url.searchParams.set('model', model);
  url.searchParams.set('encoding', cartesiaEncoding(audioFormat));
  url.searchParams.set('sample_rate', String(audioFormat.sampleRate));
  url.searchParams.set('language', selectedLanguage);
  return Object.freeze({ endpoint: url.toString(), apiKey, accessToken, version, model, language: selectedLanguage, audioFormat });
}

function retryable(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return /timeout|reset|temporar|unavailable|rate|429|\b50[0234]\b|overflow/.test(message);
}

export function createCartesiaSttAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveCartesiaSttConfiguration(providerConfig);
  const channel = new SttEventChannel({ providerId: providerConfig.providerId, modelId: providerConfig.modelId, language: configuration.language });
  const createWebSocket = runtimeContext.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  const reconnectLimit = Math.max(0, Number(runtimeContext.reconnectLimit ?? 1));
  let socket = null;
  let closed = false;
  let connected = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let sentBytes = 0;
  let reportedBytes = 0;
  let speechOpen = false;

  const publishUsage = (requestId = null, characterCount = 0) => {
    const bytes = Math.max(0, sentBytes - reportedBytes);
    reportedBytes = sentBytes;
    channel.publish({
      type: 'usage', requestId, audioBytes: bytes,
      audioDurationMs: audioDurationMs(bytes, configuration.audioFormat), characterCount,
    });
  };

  const publishError = (error, canRetry = retryable(error)) => channel.publish({
    type: 'error', code: error?.code ?? 'STT_PROVIDER_ERROR', message: error?.message ?? String(error), retryable: canRetry,
  });

  function scheduleReconnect(error) {
    if (closed || reconnectTimer || reconnectAttempts >= reconnectLimit) return;
    reconnectAttempts += 1;
    publishError(error, true);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((connectionError) => publishError(connectionError, reconnectAttempts < reconnectLimit));
    }, Number(runtimeContext.reconnectDelayMs ?? 250));
    reconnectTimer.unref?.();
  }

  function providerMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { publishError(new Error('Cartesia STT returned invalid JSON')); return; }
    const type = String(message.type ?? '').toLowerCase();
    const requestId = message.request_id ?? message.requestId ?? null;
    if (type === 'error') {
      const error = new Error(message.message ?? message.error ?? 'Cartesia STT failed');
      error.code = message.code;
      publishError(error);
      return;
    }
    if (type === 'transcript') {
      const text = String(message.text ?? message.transcript ?? '').trim();
      if (!text) return;
      if (!speechOpen) { speechOpen = true; channel.publish({ type: 'speech_started', requestId }); }
      if (message.is_final === true || message.isFinal === true) {
        speechOpen = false;
        channel.publish({ type: 'speech_ended', requestId });
        channel.publish({ type: 'final_transcript', text, requestId, language: message.language ?? configuration.language, confidence: message.confidence ?? null });
        publishUsage(requestId, Array.from(text).length);
      } else channel.publish({ type: 'partial_transcript', text, requestId, language: message.language ?? configuration.language, confidence: message.confidence ?? null });
      return;
    }
    if (type === 'turn.start') { speechOpen = true; channel.publish({ type: 'speech_started', requestId }); }
    if (type === 'turn.update' || type === 'turn.eager_end') {
      const text = String(message.transcript ?? '').trim();
      if (text) channel.publish({ type: 'partial_transcript', text, requestId, language: configuration.language });
    }
    if (type === 'turn.end') {
      const text = String(message.transcript ?? '').trim();
      speechOpen = false;
      channel.publish({ type: 'speech_ended', requestId });
      if (text) channel.publish({ type: 'final_transcript', text, requestId, language: configuration.language });
      publishUsage(requestId, Array.from(text).length);
    }
  }

  async function connect() {
    if (closed) throw new AppError(409, 'Cartesia STT adapter is closed', 'STT_ADAPTER_CLOSED');
    if (connected && socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const headers = { 'Cartesia-Version': configuration.version };
      if (configuration.accessToken) headers.Authorization = `Bearer ${configuration.accessToken}`;
      else headers['X-API-Key'] = configuration.apiKey;
      const candidate = createWebSocket(configuration.endpoint, { headers, perMessageDeflate: false });
      socket = candidate;
      const timeout = setTimeout(() => {
        cleanup(); candidate.once('error', () => {}); candidate.terminate?.();
        reject(new AppError(504, 'Cartesia STT connection timed out', 'STT_CONNECT_TIMEOUT'));
      }, runtimeContext.connectTimeoutMs ?? env.STT_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
      const cleanup = () => { clearTimeout(timeout); candidate.off('open', onOpen); candidate.off('error', onInitialError); candidate.off('close', onInitialClose); };
      const onOpen = () => {
        cleanup(); connected = true; reconnectAttempts = 0;
        candidate.on('message', providerMessage);
        candidate.on('error', (error) => publishError(error, true));
        candidate.on('close', (code, reason) => {
          connected = false;
          if (!closed && code !== 1000) scheduleReconnect(new Error(`Cartesia STT connection closed (${code}): ${reason.toString()}`));
        });
        resolve();
      };
      const onInitialError = (error) => { cleanup(); reject(new AppError(502, `Cartesia STT connection failed: ${error.message}`, 'STT_CONNECT_FAILED')); };
      const onInitialClose = (code, reason) => { cleanup(); reject(new AppError(502, `Cartesia STT rejected the connection (${code}): ${reason.toString()}`, 'STT_CONNECT_REJECTED')); };
      candidate.once('open', onOpen); candidate.once('error', onInitialError); candidate.once('close', onInitialClose);
    });
  }

  function requireConnection() {
    if (!connected || socket?.readyState !== WebSocket.OPEN) throw new AppError(409, 'Cartesia STT WebSocket is not connected', 'STT_NOT_CONNECTED');
  }

  function sendAudio(audio) {
    requireConnection();
    if (!Buffer.isBuffer(audio) || !audio.length) throw new TypeError('STT audio must be a non-empty Buffer');
    sentBytes += audio.length;
    socket.send(audio, { binary: true });
  }

  function flush() { requireConnection(); socket.send('finalize'); }
  function cancel(reason = 'cancelled') {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null; connected = false; speechOpen = false;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, String(reason).slice(0, 123));
    socket = null;
  }
  function close() { if (closed) return; closed = true; cancel('closed'); channel.close(); }

  return { configuration, connect, sendAudio, flush, cancel, close, onEvent: (listener) => channel.subscribe(listener), events: () => channel.iterate() };
}

export function registerCartesiaSttAdapter(registry) {
  if (registry.has('stt', 'cartesia')) return;
  registry.register('stt', 'cartesia', createCartesiaSttAdapter, {
    aliases: ['cartesia-ai', 'cartesia ai', 'cartesia stt'],
    supports: ({ providerConfig }) => {
      try { const format = resolveModelAudioFormat(providerConfig, 'input'); return format.encoding === 'pcm_s16le' && format.channels === 1; } catch { return false; }
    },
    metadata: { streaming: true, transport: 'websocket', normalizedEvents: true },
  });
}
