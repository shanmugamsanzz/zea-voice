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
  const url = new URL(baseUrl || 'https://api.elevenlabs.io');
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new AppError(503, 'ElevenLabs STT base URL is invalid', 'STT_BASE_URL_INVALID');
  if (url.pathname === '/' || !url.pathname) url.pathname = '/v1/speech-to-text/realtime';
  else if (!url.pathname.endsWith('/v1/speech-to-text/realtime')) url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/speech-to-text/realtime`;
  return url;
}

function audioFormat(format) {
  if (format.channels !== 1) throw new AppError(409, 'ElevenLabs STT requires mono input audio', 'STT_AUDIO_FORMAT_UNSUPPORTED');
  if (format.encoding === 'mulaw' && format.sampleRate === 8000) return 'ulaw_8000';
  if (format.encoding === 'pcm_s16le' && [8000, 16000, 22050, 24000, 44100, 48000].includes(format.sampleRate)) return `pcm_${format.sampleRate}`;
  throw new AppError(409, `ElevenLabs STT cannot stream ${format.encoding} at ${format.sampleRate} Hz`, 'STT_AUDIO_FORMAT_UNSUPPORTED');
}

function language(value) {
  const candidate = String(value ?? '').trim();
  return candidate ? candidate.split(/[-_]/)[0].toLowerCase() : null;
}

export function resolveElevenLabsSttConfiguration(providerConfig) {
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  const inputFormat = resolveModelAudioFormat(providerConfig, 'input');
  const apiKey = parameter(providerConfig.parameters, 'ELEVENLABS_API_KEY', 'XI_API_KEY', 'API_KEY');
  if (!apiKey) throw new AppError(503, 'Selected ElevenLabs STT provider has no API key', 'STT_API_KEY_MISSING');
  const url = endpoint(providerConfig.baseUrl);
  const selectedLanguage = language(setting(settings, 'sttLanguage', 'languageCode', 'language'));
  url.searchParams.set('model_id', String(providerConfig.modelKey || 'scribe_v2_realtime'));
  url.searchParams.set('audio_format', audioFormat(inputFormat));
  if (selectedLanguage) url.searchParams.set('language_code', selectedLanguage);
  url.searchParams.set('commit_strategy', String(setting(settings, 'elevenLabsCommitStrategy', 'commitStrategy') ?? 'manual'));
  if (setting(settings, 'includeTimestamps') === true) url.searchParams.set('include_timestamps', 'true');
  return Object.freeze({ endpoint: url.toString(), apiKey, language: selectedLanguage, audioFormat: inputFormat });
}

function retryable(error) {
  const code = String(error?.code ?? '').toLowerCase();
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return ['rate_limited', 'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded'].includes(code)
    || /timeout|reset|temporar|unavailable|rate|429|\b50[0234]\b|overflow|capacity/.test(message);
}

export function createElevenLabsSttAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveElevenLabsSttConfiguration(providerConfig);
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
  let sessionId = null;

  const publishError = (error, canRetry = retryable(error)) => channel.publish({
    type: 'error', code: error?.code ?? 'STT_PROVIDER_ERROR', message: error?.message ?? String(error), retryable: canRetry,
  });
  const publishUsage = (requestId = sessionId, characterCount = 0) => {
    const bytes = Math.max(0, sentBytes - reportedBytes);
    reportedBytes = sentBytes;
    channel.publish({
      type: 'usage', requestId, audioBytes: bytes,
      audioDurationMs: audioDurationMs(bytes, configuration.audioFormat), characterCount,
    });
  };

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
    try { message = JSON.parse(raw.toString('utf8')); } catch { publishError(new Error('ElevenLabs STT returned invalid JSON')); return; }
    const type = String(message.message_type ?? message.type ?? '').toLowerCase();
    const requestId = message.session_id ?? message.sessionId ?? sessionId;
    if (type === 'session_started') { sessionId = requestId ?? sessionId; return; }
    if (['error', 'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error', 'invalid_request', 'rate_limited', 'queue_overflow', 'resource_exhausted'].includes(type)) {
      const error = new Error(message.error ?? message.message ?? message.warning ?? 'ElevenLabs STT failed');
      error.code = type;
      publishError(error);
      return;
    }
    if (type === 'partial_transcript') {
      const text = String(message.text ?? '').trim();
      if (!text) return;
      if (!speechOpen) { speechOpen = true; channel.publish({ type: 'speech_started', requestId }); }
      channel.publish({ type: 'partial_transcript', text, requestId, language: message.language_code ?? configuration.language, confidence: message.confidence ?? null });
      return;
    }
    if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
      const text = String(message.text ?? '').trim();
      if (!speechOpen) { speechOpen = true; channel.publish({ type: 'speech_started', requestId }); }
      speechOpen = false;
      channel.publish({ type: 'speech_ended', requestId });
      if (text) channel.publish({ type: 'final_transcript', text, requestId, language: message.language_code ?? configuration.language, confidence: message.confidence ?? null });
      publishUsage(requestId, Array.from(text).length);
    }
  }

  async function connect() {
    if (closed) throw new AppError(409, 'ElevenLabs STT adapter is closed', 'STT_ADAPTER_CLOSED');
    if (connected && socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const candidate = createWebSocket(configuration.endpoint, { headers: { 'xi-api-key': configuration.apiKey }, perMessageDeflate: false });
      socket = candidate;
      const timeout = setTimeout(() => {
        cleanup(); candidate.once('error', () => {}); candidate.terminate?.();
        reject(new AppError(504, 'ElevenLabs STT connection timed out', 'STT_CONNECT_TIMEOUT'));
      }, runtimeContext.connectTimeoutMs ?? env.STT_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
      const cleanup = () => { clearTimeout(timeout); candidate.off('open', onOpen); candidate.off('error', onInitialError); candidate.off('close', onInitialClose); };
      const onOpen = () => {
        cleanup(); connected = true; reconnectAttempts = 0;
        candidate.on('message', providerMessage);
        candidate.on('error', (error) => publishError(error, true));
        candidate.on('close', (code, reason) => {
          connected = false;
          if (!closed && code !== 1000) scheduleReconnect(new Error(`ElevenLabs STT connection closed (${code}): ${reason.toString()}`));
        });
        resolve();
      };
      const onInitialError = (error) => { cleanup(); reject(new AppError(502, `ElevenLabs STT connection failed: ${error.message}`, 'STT_CONNECT_FAILED')); };
      const onInitialClose = (code, reason) => { cleanup(); reject(new AppError(502, `ElevenLabs STT rejected the connection (${code}): ${reason.toString()}`, 'STT_CONNECT_REJECTED')); };
      candidate.once('open', onOpen); candidate.once('error', onInitialError); candidate.once('close', onInitialClose);
    });
  }

  function requireConnection() {
    if (!connected || socket?.readyState !== WebSocket.OPEN) throw new AppError(409, 'ElevenLabs STT WebSocket is not connected', 'STT_NOT_CONNECTED');
  }
  function sendAudio(audio) {
    requireConnection();
    if (!Buffer.isBuffer(audio) || !audio.length) throw new TypeError('STT audio must be a non-empty Buffer');
    sentBytes += audio.length;
    socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: audio.toString('base64') }));
  }
  function flush() { requireConnection(); socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true })); }
  function cancel(reason = 'cancelled') {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null; connected = false; speechOpen = false;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, String(reason).slice(0, 123));
    socket = null;
  }
  function close() { if (closed) return; closed = true; cancel('closed'); channel.close(); }

  return { configuration, connect, sendAudio, flush, cancel, close, onEvent: (listener) => channel.subscribe(listener), events: () => channel.iterate() };
}

export function registerElevenLabsSttAdapter(registry) {
  if (registry.has('stt', 'elevenlabs')) return;
  registry.register('stt', 'elevenlabs', createElevenLabsSttAdapter, {
    aliases: ['eleven-labs', 'eleven labs', '11labs', 'elevenlabs stt'],
    supports: ({ providerConfig }) => {
      try { audioFormat(resolveModelAudioFormat(providerConfig, 'input')); return true; } catch { return false; }
    },
    metadata: { streaming: true, transport: 'websocket', normalizedEvents: true },
  });
}
