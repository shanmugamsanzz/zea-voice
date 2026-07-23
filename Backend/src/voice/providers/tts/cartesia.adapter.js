import { randomUUID } from 'node:crypto';
import { AppError } from '../../../middleware/errors.js';
import { audioDurationMs } from '../../audio/audio-format.js';
import {
  createTtsRequestState, firstPronunciationDictionary, parameter, parseSse,
  requireAudioResponse, resolveCommonTtsConfiguration, synthesisInput, ttsErrorEvent, ttsFailure,
} from './streaming-runtime.js';
import { normalizeTtsEvent, normalizeTtsUsage } from './tts.interface.js';

function endpoint(baseUrl) {
  const url = new URL(baseUrl || 'https://api.cartesia.ai');
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.pathname.endsWith('/tts/websocket')) url.pathname = url.pathname.replace(/\/websocket$/, '/sse');
  else if (url.pathname === '/' || !url.pathname) url.pathname = '/tts/sse';
  else if (!url.pathname.endsWith('/tts/sse')) url.pathname = `${url.pathname.replace(/\/$/, '')}/tts/sse`;
  return url.toString();
}

function outputFormat(format) {
  const encoding = { pcm_s16le: 'pcm_s16le', mulaw: 'pcm_mulaw' }[format.encoding];
  if (!encoding) throw new AppError(409, `Cartesia TTS cannot stream ${format.encoding}`, 'TTS_AUDIO_FORMAT_UNSUPPORTED');
  return { container: 'raw', encoding, sample_rate: format.sampleRate };
}

export function resolveCartesiaTtsConfiguration(providerConfig) {
  const common = resolveCommonTtsConfiguration(providerConfig);
  const apiKey = parameter(providerConfig.parameters, 'CARTESIA_API_KEY', 'X_API_KEY', 'API_KEY');
  const accessToken = parameter(providerConfig.parameters, 'CARTESIA_ACCESS_TOKEN', 'ACCESS_TOKEN');
  if (!apiKey && !accessToken) throw new AppError(503, 'Selected Cartesia TTS provider has no credential', 'TTS_API_KEY_MISSING');
  const version = parameter(providerConfig.parameters, 'CARTESIA_VERSION', 'API_VERSION') ?? '2026-03-01';
  const dictionary = firstPronunciationDictionary(common.pronunciationRules, 'cartesia');
  return Object.freeze({ ...common, endpoint: endpoint(providerConfig.baseUrl), apiKey, accessToken, version, dictionary });
}

export function createCartesiaTtsAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveCartesiaTtsConfiguration(providerConfig);
  const state = createTtsRequestState(providerConfig, runtimeContext);
  const fetchImpl = runtimeContext.fetch ?? globalThis.fetch;
  return {
    configuration,
    async connect() {},
    async *synthesizeStream(input) {
      const synthesis = synthesisInput(input);
      const request = state.begin(synthesis.generationId);
      let bytes = 0;
      let sequence = 0;
      let firstAudioLatencyMs = null;
      try {
        const headers = { 'content-type': 'application/json', accept: 'text/event-stream', 'Cartesia-Version': configuration.version };
        if (configuration.accessToken) headers.Authorization = `Bearer ${configuration.accessToken}`;
        else headers['X-API-Key'] = configuration.apiKey;
        const body = {
          model_id: configuration.model,
          transcript: synthesis.text,
          voice: { mode: 'id', id: configuration.voiceId },
          language: configuration.language.split('-')[0],
          context_id: randomUUID(),
          output_format: outputFormat(configuration.outputFormat),
          generation_config: {
            speed: Math.min(1.5, Math.max(0.6, configuration.speed)),
            volume: Math.min(2, Math.max(0.5, configuration.volume)),
            ...(configuration.style ? { emotion: String(configuration.style) } : {}),
          },
        };
        if (configuration.dictionary?.id) body.pronunciation_dict_id = configuration.dictionary.id;
        const response = await fetchImpl(configuration.endpoint, {
          method: 'POST', headers, signal: request.controller.signal, body: JSON.stringify(body),
        });
        await requireAudioResponse(response, providerConfig);
        for await (const raw of parseSse(response.body)) {
          let event;
          try { event = JSON.parse(raw); } catch { throw new AppError(502, 'Cartesia returned invalid streaming JSON', 'TTS_STREAM_JSON_INVALID'); }
          if (event.type === 'error') throw new AppError(502, event.message ?? event.title ?? 'Cartesia synthesis failed', 'TTS_PROVIDER_REQUEST_FAILED');
          if (event.type !== 'chunk' || !event.data) continue;
          const audio = Buffer.from(event.data, 'base64');
          if (!audio.length) continue;
          if (firstAudioLatencyMs === null) firstAudioLatencyMs = Date.now() - request.startedAt;
          bytes += audio.length;
          yield normalizeTtsEvent({ type: 'audio_chunk', audio, sequence: sequence++ }, { ...providerConfig, generationId: request.generationId });
        }
        const usage = normalizeTtsUsage({
          characters: synthesis.text.length, audioBytes: bytes, firstAudioLatencyMs,
          audioOutputMs: audioDurationMs(bytes, configuration.outputFormat),
        });
        yield normalizeTtsEvent({ type: 'usage', usage }, { ...providerConfig, generationId: request.generationId });
        yield normalizeTtsEvent({ type: 'completed', usage }, { ...providerConfig, generationId: request.generationId });
      } catch (error) {
        const failure = ttsFailure(error, request, providerConfig);
        if (!failure) yield normalizeTtsEvent({ type: 'cancelled', reason: request.cancelReason }, { ...providerConfig, generationId: request.generationId });
        else yield ttsErrorEvent(failure, providerConfig, request.generationId);
      } finally { request.finish(); }
    },
    cancel: (reason) => state.cancel(reason),
    close: () => state.close(),
  };
}

export function registerCartesiaTtsAdapter(registry) {
  if (registry.has('tts', 'cartesia')) return;
  registry.register('tts', 'cartesia', createCartesiaTtsAdapter, {
    aliases: ['cartesia-ai', 'cartesia ai', 'cartesia tts'],
    metadata: { streaming: true, transport: 'sse', normalizedEvents: true },
  });
}
