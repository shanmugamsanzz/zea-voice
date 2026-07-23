import { AppError } from '../../../middleware/errors.js';
import {
  binaryAudioEvents, createTtsRequestState, firstPronunciationDictionary, parameter,
  requireAudioResponse, resolveCommonTtsConfiguration, setting, synthesisInput,
  ttsErrorEvent, ttsFailure,
} from './streaming-runtime.js';
import { normalizeTtsEvent } from './tts.interface.js';

function endpoint(baseUrl) {
  if (!baseUrl) throw new AppError(503, 'Selected Sarvam TTS provider has no base URL', 'TTS_BASE_URL_MISSING');
  const url = new URL(baseUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.pathname.endsWith('/text-to-speech/ws')) url.pathname = url.pathname.replace(/\/ws$/, '/stream');
  else if (url.pathname === '/' || !url.pathname) url.pathname = '/text-to-speech/stream';
  else if (!url.pathname.endsWith('/text-to-speech/stream')) url.pathname = `${url.pathname.replace(/\/$/, '')}/text-to-speech/stream`;
  return url.toString();
}

function outputCodec(format) {
  if (format.encoding === 'mulaw') return 'mulaw';
  if (format.encoding === 'pcm_s16le') return 'linear16';
  throw new AppError(409, `Sarvam TTS cannot stream ${format.encoding}`, 'TTS_AUDIO_FORMAT_UNSUPPORTED');
}

export function resolveSarvamTtsConfiguration(providerConfig) {
  const common = resolveCommonTtsConfiguration(providerConfig);
  const apiKey = parameter(providerConfig.parameters, 'SARVAM_API_KEY', 'SARVAM_API_SUBSCRIPTION_KEY', 'API_SUBSCRIPTION_KEY', 'API_KEY');
  if (!apiKey) throw new AppError(503, 'Selected Sarvam TTS provider has no API key', 'TTS_API_KEY_MISSING');
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  const dictionary = firstPronunciationDictionary(common.pronunciationRules, 'sarvam');
  return Object.freeze({
    ...common,
    endpoint: endpoint(providerConfig.baseUrl),
    apiKey,
    outputCodec: outputCodec(common.outputFormat),
    pitch: Number(setting(settings, 'ttsPitch', 'pitch') ?? 0),
    temperature: Number(setting(settings, 'ttsTemperature', 'temperature') ?? 0.6),
    dictionaryId: dictionary?.id ?? parameter(providerConfig.parameters, 'SARVAM_DICTIONARY_ID', 'DICTIONARY_ID'),
  });
}

export function createSarvamTtsAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveSarvamTtsConfiguration(providerConfig);
  const state = createTtsRequestState(providerConfig, runtimeContext);
  const fetchImpl = runtimeContext.fetch ?? globalThis.fetch;
  return {
    configuration,
    async connect() {},
    async *synthesizeStream(input) {
      const synthesis = synthesisInput(input);
      const request = state.begin(synthesis.generationId);
      try {
        const body = {
          text: synthesis.text,
          target_language_code: configuration.language,
          speaker: configuration.voiceId,
          pace: configuration.speed,
          speech_sample_rate: configuration.outputFormat.sampleRate,
          model: configuration.model,
          output_audio_codec: configuration.outputCodec,
        };
        if (configuration.model?.includes('v2')) {
          body.pitch = configuration.pitch;
          body.loudness = configuration.volume;
        } else body.temperature = configuration.temperature;
        if (configuration.dictionaryId) body.dict_id = configuration.dictionaryId;
        const response = await fetchImpl(configuration.endpoint, {
          method: 'POST', signal: request.controller.signal,
          headers: { 'api-subscription-key': configuration.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        await requireAudioResponse(response, providerConfig);
        yield* binaryAudioEvents(response, request, providerConfig, configuration, synthesis.text.length);
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

export function registerSarvamTtsAdapter(registry) {
  if (registry.has('tts', 'sarvam')) return;
  registry.register('tts', 'sarvam', createSarvamTtsAdapter, {
    aliases: ['sarvam-ai', 'sarvam ai', 'sarvam tts'],
    supports: ({ providerConfig }) => {
      try { return ['mulaw', 'pcm_s16le'].includes(resolveCommonTtsConfiguration(providerConfig).outputFormat.encoding); } catch { return false; }
    },
    metadata: { streaming: true, transport: 'http-chunked', normalizedEvents: true },
  });
}
