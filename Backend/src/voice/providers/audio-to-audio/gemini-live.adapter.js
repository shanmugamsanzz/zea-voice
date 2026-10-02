import { AppError } from '../../../middleware/errors.js';
import { createRealtimeWebSocketAdapter, parameter, realtimeAudioFormats, setting, websocketUrl } from './realtime-websocket-runtime.js';

function mime(format) { return `audio/pcm;rate=${format.sampleRate}`; }

function resolveGeminiLiveConfiguration(providerConfig) {
  const apiKey = parameter(providerConfig.parameters, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'API_KEY');
  if (!apiKey) throw new AppError(503, 'Selected Gemini Live provider has no API key', 'AUDIO_TO_AUDIO_API_KEY_MISSING');
  const { inputFormat, outputFormat } = realtimeAudioFormats(providerConfig);
  if (inputFormat.encoding !== 'pcm_s16le' || outputFormat.encoding !== 'pcm_s16le') {
    throw new AppError(409, 'Gemini Live Audio requires pcm_s16le input and output', 'AUDIO_TO_AUDIO_FORMAT_UNSUPPORTED');
  }
  const url = websocketUrl(providerConfig.baseUrl, 'https://generativelanguage.googleapis.com', '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
  url.searchParams.set('key', apiKey);
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  return Object.freeze({ endpoint: url.toString(), inputFormat, outputFormat,
    model: String(providerConfig.modelKey || 'gemini-2.5-flash-native-audio-preview-09-2025'),
    voice: setting(settings, 'voiceId', 'voice') ?? null, instructions: setting(settings, 'instructions', 'systemInstruction') ?? null });
}

const protocol = {
  name: 'Gemini Live', resolveConfiguration: resolveGeminiLiveConfiguration,
  connectionOptions: () => ({ perMessageDeflate: false }),
  initialMessages: (configuration) => [{ setup: {
    model: configuration.model.startsWith('models/') ? configuration.model : `models/${configuration.model}`,
    generationConfig: { responseModalities: ['AUDIO'], ...(configuration.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: configuration.voice } } } } : {}) },
    ...(configuration.instructions ? { systemInstruction: { parts: [{ text: configuration.instructions }] } } : {}),
  } }],
  audioMessages: (audio, configuration) => [{ realtimeInput: { audio: { data: audio.toString('base64'), mimeType: mime(configuration.inputFormat) } } }],
  cancelMessages: () => [{ realtimeInput: { activityStart: {} } }],
  parseMessage(raw, configuration) {
    const message = JSON.parse(raw.toString('utf8'));
    const content = message.serverContent;
    if (!content) {
      if (message.goAway) return [{ type: 'error', code: 'GEMINI_LIVE_GO_AWAY', message: 'Gemini Live session renewal required', retryable: true }];
      return [];
    }
    const events = [];
    if (content.interrupted) events.push({ type: 'cancelled', reason: 'provider-interrupted' });
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) events.push({ type: 'agent_audio', audio: data });
    }
    if (events.some((event) => event.type === 'agent_audio')) events.unshift({ type: 'response_started' });
    if (content.turnComplete) events.push({ type: 'response_completed', usage: {} });
    return events;
  },
};

export { resolveGeminiLiveConfiguration };
export const createGeminiLiveAudioAdapter = (input) => createRealtimeWebSocketAdapter({ ...input, protocol });
export function registerGeminiLiveAudioAdapter(registry) {
  if (!registry.has('audio_to_audio', 'gemini-live')) registry.register('audio_to_audio', 'gemini-live', createGeminiLiveAudioAdapter, {
    aliases: ['gemini-live', 'gemini live', 'gemini live audio'], metadata: { streaming: true, transport: 'websocket', nativeAudio: true },
  });
}
