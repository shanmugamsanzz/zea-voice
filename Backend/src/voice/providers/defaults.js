import { providerAdapterRegistry } from './registry.js';
import { registerOpenAiCompatibleLlmAdapter } from './llm/openai-compatible.adapter.js';
import { registerGeminiLlmAdapter } from './llm/gemini.adapter.js';
import { registerAnthropicLlmAdapter } from './llm/anthropic.adapter.js';
import { registerSarvamSttAdapter } from './stt/sarvam.adapter.js';
import { registerSarvamTtsAdapter } from './tts/sarvam.adapter.js';
import { registerCartesiaTtsAdapter } from './tts/cartesia.adapter.js';
import { registerElevenLabsTtsAdapter } from './tts/elevenlabs.adapter.js';
import { registerAzureTtsAdapter } from './tts/azure.adapter.js';

export function registerImplementedProviderAdapters(registry = providerAdapterRegistry) {
  registerSarvamSttAdapter(registry);
  registerSarvamTtsAdapter(registry);
  registerCartesiaTtsAdapter(registry);
  registerElevenLabsTtsAdapter(registry);
  registerAzureTtsAdapter(registry);
  registerOpenAiCompatibleLlmAdapter(registry);
  registerGeminiLlmAdapter(registry);
  registerAnthropicLlmAdapter(registry);
  return registry;
}
