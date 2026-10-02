import { providerAdapterRegistry } from './registry.js';
import { registerOpenAiCompatibleLlmAdapter } from './llm/openai-compatible.adapter.js';
import { registerGeminiLlmAdapter } from './llm/gemini.adapter.js';
import { registerAnthropicLlmAdapter } from './llm/anthropic.adapter.js';
import { registerSarvamSttAdapter } from './stt/sarvam.adapter.js';
import { registerCartesiaSttAdapter } from './stt/cartesia.adapter.js';
import { registerElevenLabsSttAdapter } from './stt/elevenlabs.adapter.js';
import { registerSarvamTtsAdapter } from './tts/sarvam.adapter.js';
import { registerCartesiaTtsAdapter } from './tts/cartesia.adapter.js';
import { registerElevenLabsTtsAdapter } from './tts/elevenlabs.adapter.js';
import { registerAzureTtsAdapter } from './tts/azure.adapter.js';
import { registerOpenAiRealtimeAudioAdapter } from './audio-to-audio/openai-realtime.adapter.js';
import { registerGeminiLiveAudioAdapter } from './audio-to-audio/gemini-live.adapter.js';
import { registerAmazonNovaSonicAudioAdapter } from './audio-to-audio/amazon-nova-sonic.adapter.js';
import { registerUltravoxAudioAdapter } from './audio-to-audio/ultravox.adapter.js';

export function registerImplementedProviderAdapters(registry = providerAdapterRegistry) {
  registerSarvamSttAdapter(registry);
  registerCartesiaSttAdapter(registry);
  registerElevenLabsSttAdapter(registry);
  registerSarvamTtsAdapter(registry);
  registerCartesiaTtsAdapter(registry);
  registerElevenLabsTtsAdapter(registry);
  registerAzureTtsAdapter(registry);
  registerOpenAiCompatibleLlmAdapter(registry);
  registerGeminiLlmAdapter(registry);
  registerAnthropicLlmAdapter(registry);
  registerOpenAiRealtimeAudioAdapter(registry);
  registerGeminiLiveAudioAdapter(registry);
  registerAmazonNovaSonicAudioAdapter(registry);
  registerUltravoxAudioAdapter(registry);
  return registry;
}
