import { AppError } from '../../../middleware/errors.js';
import { createRealtimeWebSocketAdapter, parameter, realtimeAudioFormats, websocketUrl } from './realtime-websocket-runtime.js';

/**
 * Nova Sonic's Bedrock bidirectional stream is SigV4 authenticated. A runtime
 * connector may provide a pre-signed WebSocket URL through NOVA_SONIC_WEBSOCKET_URL;
 * the adapter deliberately does not store or generate long-lived AWS secrets.
 */
export function resolveAmazonNovaSonicConfiguration(providerConfig) {
  const signedUrl = parameter(providerConfig.parameters, 'NOVA_SONIC_WEBSOCKET_URL', 'WEBSOCKET_URL');
  const authorization = parameter(providerConfig.parameters, 'NOVA_SONIC_AUTHORIZATION', 'AUTHORIZATION');
  if (!signedUrl && !providerConfig.baseUrl) throw new AppError(503, 'Selected Amazon Nova Sonic provider has no signed realtime endpoint', 'AUDIO_TO_AUDIO_ENDPOINT_MISSING');
  const { inputFormat, outputFormat } = realtimeAudioFormats(providerConfig);
  if (inputFormat.encoding !== 'pcm_s16le' || outputFormat.encoding !== 'pcm_s16le') {
    throw new AppError(409, 'Amazon Nova Sonic requires pcm_s16le input and output', 'AUDIO_TO_AUDIO_FORMAT_UNSUPPORTED');
  }
  const url = signedUrl ? new URL(signedUrl) : websocketUrl(providerConfig.baseUrl, '', '');
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new AppError(503, 'Amazon Nova Sonic realtime endpoint must be WebSocket', 'AUDIO_TO_AUDIO_BASE_URL_INVALID');
  return Object.freeze({ endpoint: url.toString(), authorization, inputFormat, outputFormat,
    model: String(providerConfig.modelKey || 'amazon.nova-sonic-v1:0') });
}

const protocol = {
  name: 'Amazon Nova Sonic', resolveConfiguration: resolveAmazonNovaSonicConfiguration,
  connectionOptions: (configuration) => ({ headers: configuration.authorization ? { Authorization: configuration.authorization } : {}, perMessageDeflate: false }),
  initialMessages: (configuration) => [{ event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024 }, modelId: configuration.model } } }],
  audioMessages: (audio) => [{ event: { audioInput: { content: audio.toString('base64') } } }],
  cancelMessages: () => [{ event: { contentEnd: {} } }],
  parseMessage(raw) {
    const message = JSON.parse(raw.toString('utf8'));
    const event = message.event ?? {};
    if (event.audioOutput?.content) return [{ type: 'agent_audio', audio: event.audioOutput.content }];
    if (event.contentStart) return [{ type: 'response_started', responseId: event.contentStart.contentId }];
    if (event.contentEnd) return [{ type: 'response_completed', responseId: event.contentEnd.contentId, usage: event.usage ?? {} }];
    if (event.inputTranscript) return [{ type: 'input_speech_ended' }];
    if (event.error) return [{ type: 'error', code: event.error.code, message: event.error.message, retryable: event.error.retryable === true }];
    return [];
  },
};

export const createAmazonNovaSonicAudioAdapter = (input) => createRealtimeWebSocketAdapter({ ...input, protocol });
export function registerAmazonNovaSonicAudioAdapter(registry) {
  if (!registry.has('audio_to_audio', 'amazon-nova-sonic')) registry.register('audio_to_audio', 'amazon-nova-sonic', createAmazonNovaSonicAudioAdapter, {
    aliases: ['amazon_nova_sonic', 'amazon nova sonic', 'nova sonic'], metadata: { streaming: true, transport: 'bidirectional-websocket', nativeAudio: true, signedConnection: true },
  });
}
