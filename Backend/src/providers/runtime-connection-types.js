/**
 * Provider setup catalogue only. This does not register, select, or execute a
 * voice runtime adapter. Runtime wiring remains deliberately separate.
 */
export const providerRuntimeConnectionTypes = Object.freeze({
  llm: Object.freeze([
    { value: 'openai', label: 'OpenAI', availability: 'supported', runtimeAdapter: 'openai-compatible' },
    { value: 'gemini', label: 'Gemini', availability: 'supported', runtimeAdapter: 'gemini' },
    { value: 'anthropic', label: 'Anthropic', availability: 'supported', runtimeAdapter: 'anthropic' },
    { value: 'groq', label: 'Groq', availability: 'supported', runtimeAdapter: 'openai-compatible' },
    { value: 'azure_openai', label: 'Azure OpenAI', availability: 'supported', runtimeAdapter: 'azure-openai' },
  ]),
  stt: Object.freeze([
    { value: 'sarvam', label: 'Sarvam', availability: 'supported', runtimeAdapter: 'sarvam' },
    { value: 'cartesia', label: 'Cartesia', availability: 'supported', runtimeAdapter: 'cartesia' },
    { value: 'elevenlabs', label: 'ElevenLabs', availability: 'supported', runtimeAdapter: 'elevenlabs' },
  ]),
  tts: Object.freeze([
    { value: 'cartesia', label: 'Cartesia', availability: 'supported', runtimeAdapter: 'cartesia' },
    { value: 'sarvam', label: 'Sarvam', availability: 'supported', runtimeAdapter: 'sarvam' },
    { value: 'elevenlabs', label: 'ElevenLabs', availability: 'supported', runtimeAdapter: 'elevenlabs' },
    { value: 'azure', label: 'Azure', availability: 'supported', runtimeAdapter: 'azure' },
  ]),
  audio_to_audio: Object.freeze([
    { value: 'openai_realtime', label: 'OpenAI Realtime', availability: 'supported', runtimeAdapter: 'openai-realtime' },
    { value: 'gemini_live', label: 'Gemini Live', availability: 'supported', runtimeAdapter: 'gemini-live' },
    { value: 'amazon_nova_sonic', label: 'Amazon Nova Sonic', availability: 'supported', runtimeAdapter: 'amazon-nova-sonic' },
    { value: 'ultravox', label: 'Ultravox', availability: 'supported', runtimeAdapter: 'ultravox' },
  ]),
  // Pricing-only category. Plivo runtime connection remains managed by Telephony Accounts.
  telephony: Object.freeze([
    { value: 'plivo', label: 'Plivo', availability: 'adapter_required', runtimeAdapter: null },
  ]),
});

export const providerTypes = Object.freeze(Object.keys(providerRuntimeConnectionTypes));

export function runtimeConnectionOptions(type) {
  return providerRuntimeConnectionTypes[type] ?? [];
}

export function defaultRuntimeConnectionType(type) {
  return runtimeConnectionOptions(type)[0]?.value ?? null;
}

export function isRuntimeConnectionTypeForProvider(type, value) {
  return runtimeConnectionOptions(type).some((option) => option.value === value);
}

export function runtimeConnectionMetadata(type, value) {
  return runtimeConnectionOptions(type).find((option) => option.value === value) ?? null;
}

export function isRuntimeConnectionLiveEligible(type, value, providerStatus) {
  const metadata = runtimeConnectionMetadata(type, value);
  return metadata?.availability === 'supported'
    && Boolean(metadata.runtimeAdapter)
    && providerStatus === 'connected';
}

export function runtimeConnectionStatus(type, value, providerStatus) {
  return isRuntimeConnectionLiveEligible(type, value, providerStatus)
    ? 'runtime_supported' : 'configuration_only';
}

export function bindRuntimeConnectionToCapabilities(type, value, capabilities = {}) {
  const metadata = runtimeConnectionMetadata(type, value);
  const runtime = capabilities.runtime && typeof capabilities.runtime === 'object'
    ? capabilities.runtime : {};
  return {
    ...capabilities,
    runtime: {
      ...runtime,
      connectionType: value ?? null,
      adapter: metadata?.runtimeAdapter ?? null,
      streaming: metadata?.availability === 'supported',
    },
  };
}
