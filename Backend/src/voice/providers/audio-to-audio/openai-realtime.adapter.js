import { AppError } from '../../../middleware/errors.js';
import { createRealtimeWebSocketAdapter, parameter, realtimeAudioFormats, setting, websocketUrl } from './realtime-websocket-runtime.js';

function resolveOpenAiRealtimeConfiguration(providerConfig) {
  const apiKey = parameter(providerConfig.parameters, 'OPENAI_API_KEY', 'API_KEY');
  if (!apiKey) throw new AppError(503, 'Selected OpenAI Realtime provider has no API key', 'AUDIO_TO_AUDIO_API_KEY_MISSING');
  const { inputFormat, outputFormat } = realtimeAudioFormats(providerConfig);
  if (inputFormat.encoding !== 'pcm_s16le' || outputFormat.encoding !== 'pcm_s16le') {
    throw new AppError(409, 'OpenAI Realtime Audio requires pcm_s16le input and output', 'AUDIO_TO_AUDIO_FORMAT_UNSUPPORTED');
  }
  const url = websocketUrl(providerConfig.baseUrl, 'https://api.openai.com', '/v1/realtime');
  url.searchParams.set('model', String(providerConfig.modelKey || 'gpt-realtime'));
  const settings = providerConfig.effectiveSettings ?? providerConfig.modelSettings ?? {};
  return Object.freeze({ endpoint: url.toString(), apiKey, inputFormat, outputFormat,
    voice: setting(settings, 'voiceId', 'voice') ?? null, instructions: setting(settings, 'instructions', 'systemInstruction') ?? null });
}

const protocol = {
  name: 'OpenAI Realtime',
  resolveConfiguration: resolveOpenAiRealtimeConfiguration,
  connectionOptions: (configuration) => ({ headers: { Authorization: `Bearer ${configuration.apiKey}`, 'OpenAI-Beta': 'realtime=v1' }, perMessageDeflate: false }),
  initialMessages: (configuration) => [{ type: 'session.update', session: {
    type: 'realtime', output_modalities: ['audio'], input_audio_format: 'pcm16', output_audio_format: 'pcm16',
    ...(configuration.voice ? { voice: configuration.voice } : {}),
    ...(configuration.instructions ? { instructions: configuration.instructions } : {}),
  } }],
  audioMessages: (audio) => [{ type: 'input_audio_buffer.append', audio: audio.toString('base64') }],
  cancelMessages: () => [{ type: 'response.cancel' }, { type: 'input_audio_buffer.clear' }],
  parseMessage(raw) {
    const message = JSON.parse(raw.toString('utf8'));
    if (message.type === 'input_audio_buffer.speech_started') return [{ type: 'input_speech_started' }];
    if (message.type === 'input_audio_buffer.speech_stopped') return [{ type: 'input_speech_ended' }];
    if (message.type === 'response.created') return [{ type: 'response_started', responseId: message.response?.id }];
    if (['response.audio.delta', 'response.output_audio.delta'].includes(message.type) && message.delta) return [{ type: 'agent_audio', audio: message.delta, responseId: message.response_id }];
    if (message.type === 'response.done') {
      const usage = message.response?.usage ?? {};
      return [{ type: 'response_completed', responseId: message.response?.id, usage: {
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
        cachedInputTokens: usage.input_token_details?.cached_tokens,
        audioInputTokens: usage.input_token_details?.audio_tokens,
        audioOutputTokens: usage.output_token_details?.audio_tokens,
      } }];
    }
    if (message.type === 'error') return [{ type: 'error', code: message.error?.code, message: message.error?.message, retryable: false }];
    return [];
  },
};

export { resolveOpenAiRealtimeConfiguration };
export const createOpenAiRealtimeAudioAdapter = (input) => createRealtimeWebSocketAdapter({ ...input, protocol });
export function registerOpenAiRealtimeAudioAdapter(registry) {
  if (!registry.has('audio_to_audio', 'openai-realtime')) registry.register('audio_to_audio', 'openai-realtime', createOpenAiRealtimeAudioAdapter, {
    aliases: ['openai-realtime', 'openai realtime', 'openai realtime audio'], metadata: { streaming: true, transport: 'websocket', nativeAudio: true },
  });
}
