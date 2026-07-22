import { AppError } from '../../../middleware/errors.js';
import {
  binaryAudioEvents, createTtsRequestState, firstPronunciationDictionary, parameter,
  requireAudioResponse, resolveCommonTtsConfiguration, synthesisInput, ttsErrorEvent, ttsFailure,
} from './streaming-runtime.js';
import { normalizeTtsEvent } from './tts.interface.js';

function endpoint(baseUrl, voiceId) {
  const url = new URL(baseUrl || 'https://api.elevenlabs.io');
  const suffix = `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`;
  if (!url.pathname.includes('/text-to-speech/')) url.pathname = `${url.pathname.replace(/\/$/, '')}${suffix}`;
  return url;
}

function outputFormat(format) {
  if (format.encoding === 'mulaw' && format.sampleRate === 8000) return 'ulaw_8000';
  if (format.encoding === 'pcm_s16le' && [16000, 22050, 24000, 44100].includes(format.sampleRate)) return `pcm_${format.sampleRate}`;
  throw new AppError(409, `ElevenLabs TTS cannot stream ${format.encoding} at ${format.sampleRate} Hz`, 'TTS_AUDIO_FORMAT_UNSUPPORTED');
}

export function resolveElevenLabsTtsConfiguration(providerConfig) {
  const common = resolveCommonTtsConfiguration(providerConfig);
  const apiKey = parameter(providerConfig.parameters, 'ELEVENLABS_API_KEY', 'XI_API_KEY', 'API_KEY');
  if (!apiKey) throw new AppError(503, 'Selected ElevenLabs TTS provider has no API key', 'TTS_API_KEY_MISSING');
  const dictionary = firstPronunciationDictionary(common.pronunciationRules, 'elevenlabs');
  const url = endpoint(providerConfig.baseUrl, common.voiceId);
  url.searchParams.set('output_format', outputFormat(common.outputFormat));
  return Object.freeze({ ...common, endpoint: url.toString(), apiKey, dictionary });
}

export function createElevenLabsTtsAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveElevenLabsTtsConfiguration(providerConfig);
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
          model_id: configuration.model,
          language_code: configuration.language.split('-')[0],
          voice_settings: {
            stability: configuration.stability,
            similarity_boost: configuration.similarity,
            style: configuration.styleDegree,
            speed: configuration.speed,
          },
        };
        if (configuration.dictionary?.id) body.pronunciation_dictionary_locators = [{
          pronunciation_dictionary_id: configuration.dictionary.id,
          ...(configuration.dictionary.versionId ? { version_id: configuration.dictionary.versionId } : {}),
        }];
        const response = await fetchImpl(configuration.endpoint, {
          method: 'POST', signal: request.controller.signal,
          headers: { 'xi-api-key': configuration.apiKey, 'content-type': 'application/json', accept: 'audio/*' },
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

export function registerElevenLabsTtsAdapter(registry) {
  if (registry.has('tts', 'elevenlabs')) return;
  registry.register('tts', 'elevenlabs', createElevenLabsTtsAdapter, {
    aliases: ['eleven-labs', 'eleven labs', '11labs'],
    metadata: { streaming: true, transport: 'http-chunked', normalizedEvents: true },
  });
}
