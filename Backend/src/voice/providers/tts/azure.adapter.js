import { AppError } from '../../../middleware/errors.js';
import {
  binaryAudioEvents, createTtsRequestState, firstPronunciationDictionary, parameter,
  requireAudioResponse, resolveCommonTtsConfiguration, synthesisInput, ttsErrorEvent, ttsFailure,
} from './streaming-runtime.js';
import { normalizeTtsEvent } from './tts.interface.js';

const xmlEscape = (value) => String(value).replace(/[<>&'\"]/g, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
})[character]);

function endpoint(baseUrl, parameters) {
  let selected = baseUrl;
  if (!selected) {
    const region = parameter(parameters, 'AZURE_SPEECH_REGION', 'SPEECH_REGION', 'REGION');
    if (region) selected = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  }
  if (!selected) throw new AppError(503, 'Selected Azure TTS provider has no endpoint or region', 'TTS_BASE_URL_MISSING');
  const url = new URL(selected);
  if (!url.pathname.includes('/cognitiveservices/v1')) url.pathname = `${url.pathname.replace(/\/$/, '')}/cognitiveservices/v1`;
  return url.toString();
}

function outputFormat(format) {
  if (format.encoding === 'mulaw' && format.sampleRate === 8000) return 'raw-8khz-8bit-mono-mulaw';
  if (format.encoding === 'pcm_s16le' && [8000, 16000, 24000, 48000].includes(format.sampleRate)) {
    return `raw-${format.sampleRate / 1000}khz-16bit-mono-pcm`;
  }
  throw new AppError(409, `Azure TTS cannot stream ${format.encoding} at ${format.sampleRate} Hz`, 'TTS_AUDIO_FORMAT_UNSUPPORTED');
}

function ssml(text, configuration) {
  const lexicon = configuration.dictionary?.lexiconUri
    ? `<lexicon uri="${xmlEscape(configuration.dictionary.lexiconUri)}"/>` : '';
  const prosody = `<prosody rate="${configuration.speed}" volume="${Math.round(configuration.volume * 100)}%">${xmlEscape(text)}</prosody>`;
  const styled = configuration.style
    ? `<mstts:express-as style="${xmlEscape(configuration.style)}" styledegree="${configuration.styleDegree}">${prosody}</mstts:express-as>`
    : prosody;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${xmlEscape(configuration.language)}">${lexicon}<voice name="${xmlEscape(configuration.voiceId)}">${styled}</voice></speak>`;
}

export function resolveAzureTtsConfiguration(providerConfig) {
  const common = resolveCommonTtsConfiguration(providerConfig);
  const apiKey = parameter(providerConfig.parameters, 'AZURE_SPEECH_KEY', 'SPEECH_KEY', 'AZURE_API_KEY', 'API_KEY');
  const accessToken = parameter(providerConfig.parameters, 'AZURE_SPEECH_TOKEN', 'ACCESS_TOKEN', 'TOKEN');
  if (!apiKey && !accessToken) throw new AppError(503, 'Selected Azure TTS provider has no credential', 'TTS_API_KEY_MISSING');
  return Object.freeze({
    ...common, apiKey, accessToken,
    endpoint: endpoint(providerConfig.baseUrl, providerConfig.parameters),
    azureOutputFormat: outputFormat(common.outputFormat),
    dictionary: firstPronunciationDictionary(common.pronunciationRules, 'azure'),
  });
}

export function createAzureTtsAdapter({ providerConfig, runtimeContext = {} }) {
  const configuration = resolveAzureTtsConfiguration(providerConfig);
  const state = createTtsRequestState(providerConfig, runtimeContext);
  const fetchImpl = runtimeContext.fetch ?? globalThis.fetch;
  return {
    configuration,
    async connect() {},
    async *synthesizeStream(input) {
      const synthesis = synthesisInput(input);
      const request = state.begin(synthesis.generationId);
      try {
        const headers = {
          'content-type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': configuration.azureOutputFormat,
          'User-Agent': 'Zea-Voice', accept: 'audio/*',
        };
        if (configuration.accessToken) headers.Authorization = `Bearer ${configuration.accessToken}`;
        else headers['Ocp-Apim-Subscription-Key'] = configuration.apiKey;
        const response = await fetchImpl(configuration.endpoint, {
          method: 'POST', headers, signal: request.controller.signal, body: ssml(synthesis.text, configuration),
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

export function registerAzureTtsAdapter(registry) {
  if (registry.has('tts', 'azure-speech')) return;
  registry.register('tts', 'azure-speech', createAzureTtsAdapter, {
    aliases: ['azure', 'azure tts', 'azure speech', 'microsoft azure speech'],
    metadata: { streaming: true, transport: 'http-chunked', normalizedEvents: true },
  });
}
