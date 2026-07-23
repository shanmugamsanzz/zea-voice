import assert from 'node:assert/strict';
import { ProviderAdapterRegistry } from '../src/voice/providers/registry.js';
import { registerImplementedProviderAdapters } from '../src/voice/providers/defaults.js';
import { createSarvamTtsAdapter } from '../src/voice/providers/tts/sarvam.adapter.js';
import { createCartesiaTtsAdapter } from '../src/voice/providers/tts/cartesia.adapter.js';
import { createElevenLabsTtsAdapter } from '../src/voice/providers/tts/elevenlabs.adapter.js';
import { createAzureTtsAdapter } from '../src/voice/providers/tts/azure.adapter.js';
import { streamSelectedTtsToPlivo } from '../src/voice/providers/tts/tts-playback.service.js';
import { ttsEventTypes } from '../src/voice/providers/tts/tts.interface.js';

const encoder = new TextEncoder();
const audio = Buffer.alloc(160, 0x7f);
const binaryResponse = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(audio.subarray(0, 80));
    controller.enqueue(audio.subarray(80));
    controller.close();
  },
}), { status: 200, headers: { 'content-type': 'audio/raw' } });
const sseResponse = (...events) => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const events = async (adapter, input = { text: 'Hello patient', generationId: 'generation-1' }) => {
  const result = [];
  for await (const event of adapter.synthesizeStream(input)) result.push(event);
  return result;
};

function config(providerName, overrides = {}) {
  return {
    providerId: `${providerName}-provider`, providerName, providerSlug: providerName.toLowerCase(),
    modelId: `${providerName}-model`, modelKey: 'voice-model', baseUrl: `https://${providerName.toLowerCase()}.example.com`,
    modelCapabilities: { streaming: true, audio: { output: { encoding: 'mulaw', sampleRate: 8000, channels: 1 } } },
    modelSettings: {},
    effectiveSettings: {
      voiceId: 'voice-123', ttsLanguage: 'ta-IN', ttsSpeed: 1.2, ttsEmotion: 'calm',
      ttsStyle: 0.4, ttsStability: 0.78, ttsSimilarityBoost: 0.75, ttsVolume: 0.8,
      pronunciationGroups: [{ provider: providerName, dictionaryId: 'dictionary-1', versionId: 'version-1' }],
    },
    parameters: { API_KEY: 'secret-key' },
    ...overrides,
  };
}

let request;
const sarvamConfig = config('Sarvam', { baseUrl: 'wss://api.sarvam.ai/text-to-speech/ws' });
const sarvam = createSarvamTtsAdapter({ providerConfig: sarvamConfig, runtimeContext: {
  fetch: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return binaryResponse(); },
} });
const sarvamEvents = await events(sarvam);
assert.equal(request.url, 'https://api.sarvam.ai/text-to-speech/stream');
assert.equal(request.options.headers['api-subscription-key'], 'secret-key');
assert.equal(request.body.model, 'voice-model');
assert.equal(request.body.speaker, 'voice-123');
assert.equal(request.body.target_language_code, 'ta-IN');
assert.equal(request.body.pace, 1.2);
assert.equal(request.body.dict_id, 'dictionary-1');
assert.deepEqual(sarvamEvents.map((event) => event.type), ['audio_chunk', 'audio_chunk', 'usage', 'completed']);

const cartesiaConfig = config('Cartesia', {
  baseUrl: 'wss://api.cartesia.ai/tts/websocket',
  modelKey: 'sonic-3',
  parameters: { CARTESIA_API_KEY: 'cartesia-key', CARTESIA_VERSION: '2026-03-01' },
});
const cartesia = createCartesiaTtsAdapter({ providerConfig: cartesiaConfig, runtimeContext: {
  fetch: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return sseResponse(
      { type: 'chunk', data: audio.toString('base64'), done: false, step_time: 12 },
      { type: 'done', done: true },
    );
  },
} });
const cartesiaEvents = await events(cartesia);
assert.equal(request.url, 'https://api.cartesia.ai/tts/sse');
assert.equal(request.options.headers['X-API-Key'], 'cartesia-key');
assert.equal(request.body.model_id, 'sonic-3');
assert.equal(request.body.voice.id, 'voice-123');
assert.equal(request.body.language, 'ta');
assert.deepEqual(request.body.output_format, { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 });
assert.deepEqual(request.body.generation_config, { speed: 1.2, volume: 0.8, emotion: 'calm' });
assert.equal(request.body.pronunciation_dict_id, 'dictionary-1');
assert.deepEqual(cartesiaEvents.map((event) => event.type), ['audio_chunk', 'usage', 'completed']);

const parameterConfiguredCartesia = createCartesiaTtsAdapter({ providerConfig: config('Cartesia', {
  effectiveSettings: { voiceId: 'agent-voice', ttsLanguage: 'ta-IN' },
  parameters: {
    CARTESIA_API_KEY: 'cartesia-key', CARTESIA_SPEED: '1.3', CARTESIA_VOLUME: '0.7',
    CARTESIA_EMOTION: 'calm', CARTESIA_VERSION: '2026-03-01',
  },
}), runtimeContext: { fetch: async () => sseResponse({ type: 'done', done: true }) } });
assert.equal(parameterConfiguredCartesia.configuration.speed, 1.3);
assert.equal(parameterConfiguredCartesia.configuration.volume, 0.7);
assert.equal(parameterConfiguredCartesia.configuration.style, 'calm');

const elevenConfig = config('ElevenLabs', { baseUrl: 'https://api.elevenlabs.io', modelKey: 'eleven_flash_v2_5' });
const eleven = createElevenLabsTtsAdapter({ providerConfig: elevenConfig, runtimeContext: {
  fetch: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return binaryResponse(); },
} });
await events(eleven);
assert.match(request.url, /\/v1\/text-to-speech\/voice-123\/stream\?output_format=ulaw_8000$/);
assert.equal(request.options.headers['xi-api-key'], 'secret-key');
assert.deepEqual(request.body.voice_settings, { stability: 0.78, similarity_boost: 0.75, style: 0.4, speed: 1.2 });
assert.deepEqual(request.body.pronunciation_dictionary_locators, [{ pronunciation_dictionary_id: 'dictionary-1', version_id: 'version-1' }]);

const azureConfig = config('Azure', {
  baseUrl: 'https://centralindia.tts.speech.microsoft.com', modelKey: 'neural',
  parameters: { AZURE_SPEECH_KEY: 'azure-key' },
});
const azure = createAzureTtsAdapter({ providerConfig: azureConfig, runtimeContext: {
  fetch: async (url, options) => { request = { url, options, body: options.body }; return binaryResponse(); },
} });
await events(azure, { text: 'A & B', generationId: 'azure-generation' });
assert.equal(request.url, 'https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1');
assert.equal(request.options.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
assert.equal(request.options.headers['X-Microsoft-OutputFormat'], 'raw-8khz-8bit-mono-mulaw');
assert.match(request.body, /xml:lang="ta-IN"/);
assert.match(request.body, /name="voice-123"/);
assert.match(request.body, /style="calm"/);
assert.match(request.body, /rate="1.2" volume="80%"/);
assert.match(request.body, /A &amp; B/);

const registry = registerImplementedProviderAdapters(new ProviderAdapterRegistry());
assert.equal(registry.resolve('tts', sarvamConfig).key, 'sarvam');
assert.equal(registry.resolve('tts', cartesiaConfig).key, 'cartesia');
assert.equal(registry.resolve('tts', elevenConfig).key, 'elevenlabs');
assert.equal(registry.resolve('tts', azureConfig).key, 'azure-speech');

const playbackOrder = [];
const playbackAdapter = createSarvamTtsAdapter({ providerConfig: sarvamConfig, runtimeContext: { fetch: async () => binaryResponse() } });
const audioEngine = {
  beginOutputGeneration(id) { playbackOrder.push(`begin:${id}`); },
  async enqueueSynthesized(chunk, id) { playbackOrder.push(`audio:${id}:${chunk.length}`); return true; },
  async flushSynthesized(id) { playbackOrder.push(`flush:${id}`); return true; },
  cancelStaleAudio() {},
};
const usage = [];
await streamSelectedTtsToPlivo({ providers: { tts: sarvamConfig } }, 'Immediate audio', {
  adapter: playbackAdapter, audioEngine, generationId: 'playback-1', usageTracker: { record: (kind, value) => usage.push({ kind, value }) },
});
assert.deepEqual(playbackOrder, ['begin:playback-1', 'audio:playback-1:80', 'audio:playback-1:80', 'flush:playback-1']);
assert.equal(usage[0].kind, 'tts');
assert.equal(usage[0].value.characters, 15);

let aborted = false;
const cancellation = createElevenLabsTtsAdapter({ providerConfig: elevenConfig, runtimeContext: {
  fetch: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
    aborted = true;
    reject(new DOMException('aborted', 'AbortError'));
  })),
} });
const pending = events(cancellation, { text: 'Cancel me', generationId: 'cancel-1' });
await Promise.resolve();
assert.equal(cancellation.cancel('barge-in'), true);
const cancelledEvents = await pending;
assert.equal(aborted, true);
assert.deepEqual(cancelledEvents.map((event) => event.type), ['cancelled']);
assert.deepEqual(ttsEventTypes, ['audio_chunk', 'usage', 'completed', 'cancelled', 'error']);

console.log(JSON.stringify({ success: true, task: 'Streaming TTS adapters - Sarvam, Cartesia, ElevenLabs and Azure' }));
