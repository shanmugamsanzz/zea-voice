import { AppError } from '../../../middleware/errors.js';
import { createRealtimeWebSocketAdapter, parameter, realtimeAudioFormats } from './realtime-websocket-runtime.js';

function apiEndpoint(baseUrl) {
  const url = new URL(baseUrl || 'https://api.ultravox.ai');
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.pathname === '/' || !url.pathname) url.pathname = '/api/calls';
  else if (!url.pathname.endsWith('/api/calls')) url.pathname = `${url.pathname.replace(/\/$/, '')}/api/calls`;
  return url.toString();
}

export function resolveUltravoxCallRequest(providerConfig) {
  const apiKey = parameter(providerConfig.parameters, 'ULTRAVOX_API_KEY', 'API_KEY');
  if (!apiKey) throw new AppError(503, 'Selected Ultravox provider has no API key', 'AUDIO_TO_AUDIO_API_KEY_MISSING');
  const { inputFormat, outputFormat } = realtimeAudioFormats(providerConfig);
  if (inputFormat.encoding !== 'pcm_s16le' || outputFormat.encoding !== 'pcm_s16le') {
    throw new AppError(409, 'Ultravox Realtime requires pcm_s16le input and output', 'AUDIO_TO_AUDIO_FORMAT_UNSUPPORTED');
  }
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  return Object.freeze({ apiKey, endpoint: apiEndpoint(providerConfig.baseUrl), inputFormat, outputFormat,
    model: String(providerConfig.modelKey || 'ultravox'), systemPrompt: String(settings.instructions ?? settings.systemInstruction ?? ''),
    voice: settings.voiceId ?? settings.voice ?? null, clientBufferSizeMs: Number(settings.clientBufferSizeMs ?? 30000) });
}

const protocol = {
  name: 'Ultravox Realtime',
  resolveConfiguration: (configuration) => configuration,
  connectionOptions: () => ({ perMessageDeflate: false }),
  initialMessages: () => [],
  audioMessages: (audio) => [audio],
  cancelMessages: () => [],
  parseMessage(raw, _configuration, isBinary) {
    if (isBinary) return [{ type: 'agent_audio', audio: raw }];
    const message = JSON.parse(raw.toString('utf8'));
    if (message.type === 'playback_clear_buffer') return [{ type: 'cancelled', reason: 'provider-interruption' }];
    if (message.type === 'user_started_speaking') return [{ type: 'input_speech_started' }];
    if (message.type === 'user_stopped_speaking') return [{ type: 'input_speech_ended' }];
    if (message.type === 'call_started') return [{ type: 'response_started', responseId: message.callId }];
    if (message.type === 'error') return [{ type: 'error', code: message.code, message: message.message, retryable: false }];
    return [];
  },
};

export async function createUltravoxAudioAdapter({ providerConfig, runtimeContext = {} }) {
  const request = resolveUltravoxCallRequest(providerConfig);
  const fetchImpl = runtimeContext.fetch ?? globalThis.fetch;
  const response = await fetchImpl(request.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': request.apiKey },
    body: JSON.stringify({
      systemPrompt: request.systemPrompt || undefined,
      model: request.model,
      voice: request.voice || undefined,
      medium: { serverWebSocket: {
        inputSampleRate: request.inputFormat.sampleRate,
        outputSampleRate: request.outputFormat.sampleRate,
        clientBufferSizeMs: request.clientBufferSizeMs,
      } },
    }),
  });
  if (!response?.ok) throw new AppError(502, `Ultravox call setup failed (${response?.status ?? 'network'})`, 'AUDIO_TO_AUDIO_SESSION_CREATE_FAILED');
  const body = await response.json();
  if (!body?.joinUrl) throw new AppError(502, 'Ultravox call setup returned no join URL', 'AUDIO_TO_AUDIO_SESSION_URL_MISSING');
  return createRealtimeWebSocketAdapter({
    providerConfig,
    runtimeContext,
    protocol,
    // Join URLs are short-lived provider-authorized session URLs. The API key
    // is used only during server-side call creation and never appears in it.
    configuration: { ...request, endpoint: body.joinUrl },
  });
}

// The generic runtime accepts protocol configuration synchronously. This wrapper
// provides the short-lived join URL generated above without exposing the API key.
export function registerUltravoxAudioAdapter(registry) {
  if (!registry.has('audio_to_audio', 'ultravox')) registry.register('audio_to_audio', 'ultravox', createUltravoxAudioAdapter, {
    aliases: ['ultravox-realtime', 'ultravox realtime'], metadata: { streaming: true, transport: 'websocket', nativeAudio: true },
  });
}
