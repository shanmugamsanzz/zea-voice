import { WebSocket } from 'ws';
import { AppError } from '../../../middleware/errors.js';
import { audioDurationMs, resolveModelAudioFormat } from '../../audio/audio-format.js';
import { SttEventChannel } from './stt.interface.js';

const validModes = new Set(['transcribe', 'translate', 'verbatim', 'translit', 'codemix']);
const queryFields = [
  'positive_speech_threshold', 'negative_speech_threshold', 'min_speech_frames',
  'first_turn_min_speech_frames', 'negative_frames_count', 'negative_frames_window',
  'start_speech_volume_threshold', 'interrupt_min_speech_frames', 'pre_speech_pad_frames',
  'num_initial_ignored_frames',
];

function value(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  const candidates = keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [configuredKey, configuredValue] of Object.entries(object ?? {})) {
    if (configuredValue === undefined || configuredValue === null || configuredValue === '') continue;
    const normalized = configuredKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (candidates.some((candidate) => normalized === candidate || normalized.endsWith(candidate))) return configuredValue;
  }
  return undefined;
}

function parameter(parameters, ...names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(parameters ?? {}).find(([key]) => wanted.has(key.toLowerCase()))?.[1];
}

function boolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function websocketEndpoint(baseUrl) {
  if (!baseUrl) throw new AppError(503, 'Selected Sarvam STT provider has no base URL', 'STT_BASE_URL_MISSING');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch {
    throw new AppError(503, 'Selected Sarvam STT provider base URL is invalid', 'STT_BASE_URL_INVALID');
  }
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new AppError(503, 'Selected Sarvam STT provider requires an HTTP or WebSocket base URL', 'STT_BASE_URL_INVALID');
  }
  if (endpoint.pathname === '/' || !endpoint.pathname) endpoint.pathname = '/speech-to-text/ws';
  return endpoint;
}

function sarvamCodec(format) {
  if (format.encoding === 'pcm_s16le') return 'pcm_s16le';
  if (format.encoding === 'pcm_s16be') return 'pcm_l16';
  throw new AppError(
    409,
    `Sarvam streaming STT does not accept ${format.encoding}; declare PCM input capability for this model`,
    'STT_AUDIO_FORMAT_UNSUPPORTED',
  );
}

export function resolveSarvamSttConfiguration(providerConfig) {
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  const audioFormat = resolveModelAudioFormat(providerConfig, 'input');
  const apiKey = parameter(
    providerConfig.parameters,
    'SARVAM_API_KEY', 'SARVAM_API_SUBSCRIPTION_KEY', 'API_SUBSCRIPTION_KEY', 'API_KEY', 'TOKEN',
  );
  if (!apiKey) throw new AppError(503, 'Selected Sarvam STT provider has no API key', 'STT_API_KEY_MISSING');
  const language = value(settings, 'sttLanguage', 'languageCode', 'language_code', 'language');
  if (!language) throw new AppError(409, 'Sarvam STT language is missing from the agent configuration', 'STT_LANGUAGE_MISSING');
  const selectedMode = value(settings, 'sarvamMode', 'transcriptionMode', 'mode');
  const mode = validModes.has(selectedMode) ? selectedMode : 'transcribe';
  const endpoint = websocketEndpoint(providerConfig.baseUrl);
  const highVadSensitivity = boolean(value(settings, 'sttHighVadSensitivity', 'highVadSensitivity', 'high_vad_sensitivity'), true);
  const vadSignals = boolean(value(settings, 'sttVadSignals', 'vadSignals', 'vad_signals'), true);
  const flushSignal = boolean(value(settings, 'sttFlushSignal', 'flushSignal', 'flush_signal'), true);
  const inputAudioCodec = sarvamCodec(audioFormat);
  // Sarvam uses input_audio_codec on the WebSocket URL to describe raw PCM.
  // The per-message schema still requires its MIME-style encoding discriminator.
  const messageEncoding = 'audio/wav';
  const query = {
    'language-code': language,
    model: providerConfig.modelKey,
    mode,
    sample_rate: audioFormat.sampleRate,
    input_audio_codec: inputAudioCodec,
    high_vad_sensitivity: highVadSensitivity,
    vad_signals: vadSignals,
    flush_signal: flushSignal,
  };
  for (const field of queryFields) {
    const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const configured = value(settings, `stt${camel[0].toUpperCase()}${camel.slice(1)}`, camel, field);
    if (configured !== undefined) query[field] = configured;
  }
  for (const [key, configured] of Object.entries(query)) endpoint.searchParams.set(key, String(configured));
  return Object.freeze({
    endpoint: endpoint.toString(), apiKey, language, mode, audioFormat,
    inputAudioCodec, messageEncoding, query,
  });
}

function providerError(error, retryable = false) {
  return {
    type: 'error', code: error.code ?? 'STT_PROVIDER_ERROR',
    message: error.message ?? String(error), retryable,
  };
}

export function createSarvamSttAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveSarvamSttConfiguration(providerConfig);
  const channel = new SttEventChannel({
    providerId: providerConfig.providerId,
    modelId: providerConfig.modelId,
    language: configuration.language,
  });
  const createWebSocket = runtimeContext.webSocketFactory
    ?? ((url, options) => new WebSocket(url, options));
  let socket = null;
  let closed = false;
  let connected = false;
  let sentBytes = 0;
  let reportedBytes = 0;

  function publishProviderMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch {
      channel.publish(providerError(new Error('Sarvam STT returned invalid JSON')));
      return;
    }
    const data = message.data ?? message;
    const signal = String(data.signal_type ?? data.signalType ?? message.signal_type ?? message.type ?? '').toUpperCase();
    const requestId = data.request_id ?? data.requestId ?? message.request_id ?? null;
    if (signal === 'START_SPEECH' || signal === 'SPEECH_START') {
      channel.publish({ type: 'speech_started', requestId });
      return;
    }
    if (signal === 'END_SPEECH' || signal === 'SPEECH_END') {
      channel.publish({ type: 'speech_ended', requestId });
      return;
    }
    if (message.type === 'error' || data.error) {
      channel.publish(providerError(new Error(data.message ?? data.error?.message ?? data.error ?? 'Sarvam STT failed')));
      return;
    }
    const text = String(data.transcript ?? data.translation ?? data.text ?? '').trim();
    if (!text) return;
    const partial = data.is_final === false || data.isFinal === false
      || ['partial', 'interim', 'partial_transcript'].includes(String(message.type).toLowerCase());
    channel.publish({
      type: partial ? 'partial_transcript' : 'final_transcript',
      text, requestId,
      language: data.language_code ?? data.languageCode ?? configuration.language,
      confidence: data.confidence,
    });
    if (partial) return;
    const metrics = data.metrics ?? {};
    const segmentBytes = Math.max(0, sentBytes - reportedBytes);
    reportedBytes = sentBytes;
    const providerAudioSeconds = Number(metrics.audio_duration ?? metrics.audioDuration);
    channel.publish({
      type: 'usage', requestId,
      audioDurationMs: Number.isFinite(providerAudioSeconds)
        ? providerAudioSeconds * 1000
        : audioDurationMs(segmentBytes, configuration.audioFormat),
      processingLatencyMs: Number(metrics.processing_latency ?? metrics.processingLatency ?? 0) * 1000,
      audioBytes: segmentBytes,
    });
  }

  async function connect() {
    if (closed) throw new AppError(409, 'Sarvam STT adapter is closed', 'STT_ADAPTER_CLOSED');
    if (connected && socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const candidate = createWebSocket(configuration.endpoint, {
        headers: { 'Api-Subscription-Key': configuration.apiKey },
        perMessageDeflate: false,
      });
      socket = candidate;
      const timeout = setTimeout(() => {
        cleanup();
        candidate.terminate?.();
        reject(new AppError(504, 'Sarvam STT connection timed out', 'STT_CONNECT_TIMEOUT'));
      }, runtimeContext.connectTimeoutMs ?? 10_000);
      timeout.unref?.();
      const cleanup = () => {
        clearTimeout(timeout);
        candidate.off('open', onOpen);
        candidate.off('error', onInitialError);
        candidate.off('close', onInitialClose);
      };
      const onOpen = () => {
        cleanup();
        connected = true;
        candidate.on('message', publishProviderMessage);
        candidate.on('error', (error) => channel.publish(providerError(error, true)));
        candidate.on('close', (code, reason) => {
          connected = false;
          if (!closed && code !== 1000) channel.publish(providerError(
            new Error(`Sarvam STT connection closed (${code}): ${reason.toString()}`),
            code === 1001 || code === 1006 || code === 1011,
          ));
        });
        resolve();
      };
      const onInitialError = (error) => {
        cleanup();
        reject(new AppError(502, `Sarvam STT connection failed: ${error.message}`, 'STT_CONNECT_FAILED'));
      };
      const onInitialClose = (code, reason) => {
        cleanup();
        reject(new AppError(502, `Sarvam STT rejected the connection (${code}): ${reason.toString()}`, 'STT_CONNECT_REJECTED'));
      };
      candidate.once('open', onOpen);
      candidate.once('error', onInitialError);
      candidate.once('close', onInitialClose);
    });
  }

  function requireConnection() {
    if (!connected || socket?.readyState !== WebSocket.OPEN) {
      throw new AppError(409, 'Sarvam STT WebSocket is not connected', 'STT_NOT_CONNECTED');
    }
  }

  function sendAudio(audio) {
    requireConnection();
    if (!Buffer.isBuffer(audio) || !audio.length) throw new TypeError('STT audio must be a non-empty Buffer');
    sentBytes += audio.length;
    socket.send(JSON.stringify({
      audio: {
        data: audio.toString('base64'),
        sample_rate: String(configuration.audioFormat.sampleRate),
        encoding: configuration.messageEncoding,
      },
    }));
  }

  function flush() {
    requireConnection();
    socket.send(JSON.stringify({ type: 'flush' }));
  }

  function cancel(reason = 'cancelled') {
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    connected = false;
    socket.close(1000, String(reason).slice(0, 123));
    socket = null;
  }

  function close() {
    if (closed) return;
    closed = true;
    cancel('closed');
    channel.close();
  }

  return {
    configuration,
    connect,
    sendAudio,
    flush,
    cancel,
    close,
    onEvent: (listener) => channel.subscribe(listener),
    events: () => channel.iterate(),
  };
}

export function registerSarvamSttAdapter(registry) {
  if (registry.has('stt', 'sarvam')) return;
  registry.register('stt', 'sarvam', createSarvamSttAdapter, {
    aliases: ['sarvam-ai', 'sarvam ai', 'sarvam stt'],
    supports: ({ providerConfig }) => {
      try {
        const format = resolveModelAudioFormat(providerConfig, 'input');
        return format.channels === 1 && ['pcm_s16le', 'pcm_s16be'].includes(format.encoding)
          && [8000, 16000].includes(format.sampleRate);
      } catch { return false; }
    },
    metadata: { normalizedEvents: true },
  });
}
