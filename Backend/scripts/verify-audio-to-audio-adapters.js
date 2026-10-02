import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { assertAudioToAudioAdapter, audioToAudioEventTypes } = await import('../src/voice/providers/audio-to-audio/audio-to-audio.interface.js');
const { createOpenAiRealtimeAudioAdapter } = await import('../src/voice/providers/audio-to-audio/openai-realtime.adapter.js');
const { createGeminiLiveAudioAdapter } = await import('../src/voice/providers/audio-to-audio/gemini-live.adapter.js');
const { createAmazonNovaSonicAudioAdapter } = await import('../src/voice/providers/audio-to-audio/amazon-nova-sonic.adapter.js');
const { createUltravoxAudioAdapter } = await import('../src/voice/providers/audio-to-audio/ultravox.adapter.js');
const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');
const { registerImplementedProviderAdapters } = await import('../src/voice/providers/defaults.js');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super(); this.readyState = 0; this.sent = [];
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(message) { this.sent.push(message); }
  close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
}

function config(adapter, parameters = {}) {
  return {
    providerId: `${adapter}-provider`, providerName: adapter, providerSlug: adapter,
    baseUrl: `https://${adapter}.example`, modelId: `${adapter}-model`, modelKey: `${adapter}-model`, parameters,
    modelCapabilities: { runtime: { adapter, streaming: true, protocol: 'websocket' }, audio: {
      input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
      output: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
    } },
    effectiveSettings: { voiceId: 'alloy' },
  };
}

async function socketAdapter(factory, providerConfig, runtimeContext = {}) {
  let socket;
  const adapter = assertAudioToAudioAdapter(await factory({ providerConfig, runtimeContext: {
    ...runtimeContext, webSocketFactory() { socket = new FakeWebSocket(); return socket; },
  } }));
  const events = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.connect();
  return { adapter, socket, events };
}

const openAiConfig = config('openai-realtime', { OPENAI_API_KEY: 'openai-secret' });
const openAi = await socketAdapter(createOpenAiRealtimeAudioAdapter, openAiConfig);
assert.ok(JSON.parse(openAi.socket.sent[0]).type === 'session.update');
assert.ok(!openAi.adapter.configuration.endpoint.includes('openai-secret'));
openAi.adapter.sendCustomerAudio(Buffer.alloc(640, 1));
assert.equal(JSON.parse(openAi.socket.sent[1]).type, 'input_audio_buffer.append');
openAi.socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'openai-response' } })), false);
openAi.socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.alloc(640, 2).toString('base64'), response_id: 'openai-response' })), false);
openAi.socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { id: 'openai-response', usage: { input_tokens: 4, output_tokens: 7, total_tokens: 11 } } })), false);
assert.deepEqual(openAi.events.map((event) => event.type), ['response_started', 'agent_audio', 'response_completed', 'usage']);
assert.equal(openAi.events[1].audio.length, 640);
assert.equal(openAi.events.at(-1).usage.totalTokens, 11);
openAi.adapter.cancelResponse();
assert.equal(JSON.parse(openAi.socket.sent.at(-2)).type, 'response.cancel');
openAi.adapter.close();

const geminiConfig = config('gemini-live', { GEMINI_API_KEY: 'gemini-secret' });
const gemini = await socketAdapter(createGeminiLiveAudioAdapter, geminiConfig);
assert.equal(JSON.parse(gemini.socket.sent[0]).setup.model, 'models/gemini-live-model');
assert.ok(!gemini.adapter.configuration.endpoint.includes('gemini-secret'));
gemini.adapter.sendCustomerAudio(Buffer.alloc(640, 1));
assert.equal(JSON.parse(gemini.socket.sent[1]).realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
gemini.socket.emit('message', Buffer.from(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(640, 3).toString('base64') } }] }, turnComplete: true } })), false);
assert.deepEqual(gemini.events.map((event) => event.type), ['response_started', 'agent_audio', 'response_completed', 'usage']);
gemini.adapter.close();

const novaConfig = config('amazon-nova-sonic', { NOVA_SONIC_WEBSOCKET_URL: 'wss://nova.example/realtime?X-Amz-Signature=signed' });
const nova = await socketAdapter(createAmazonNovaSonicAudioAdapter, novaConfig);
assert.ok(!nova.adapter.configuration.endpoint.includes('signed'));
nova.adapter.sendCustomerAudio(Buffer.alloc(640, 4));
assert.equal(JSON.parse(nova.socket.sent[1]).event.audioInput.content.length > 0, true);
nova.socket.emit('message', Buffer.from(JSON.stringify({ event: { contentStart: { contentId: 'nova-response' } } })), false);
nova.socket.emit('message', Buffer.from(JSON.stringify({ event: { audioOutput: { content: Buffer.alloc(640, 5).toString('base64') } } })), false);
nova.socket.emit('message', Buffer.from(JSON.stringify({ event: { contentEnd: { contentId: 'nova-response' } } })), false);
assert.deepEqual(nova.events.map((event) => event.type), ['response_started', 'agent_audio', 'response_completed', 'usage']);
nova.adapter.close();

const ultravoxConfig = config('ultravox', { ULTRAVOX_API_KEY: 'ultravox-secret' });
let ultravoxRequest;
const ultravox = await socketAdapter(createUltravoxAudioAdapter, ultravoxConfig, {
  async fetch(url, init) {
    ultravoxRequest = { url, init };
    return { ok: true, json: async () => ({ joinUrl: 'wss://join.ultravox.example/session' }) };
  },
});
assert.equal(ultravoxRequest.init.headers['X-API-Key'], 'ultravox-secret');
ultravox.adapter.sendCustomerAudio(Buffer.alloc(640, 6));
assert.equal(Buffer.isBuffer(ultravox.socket.sent[0]), true);
ultravox.socket.emit('message', Buffer.alloc(640, 7), true);
ultravox.socket.emit('message', Buffer.from(JSON.stringify({ type: 'playback_clear_buffer' })), false);
assert.deepEqual(ultravox.events.map((event) => event.type), ['agent_audio', 'cancelled']);
ultravox.adapter.close();

assert.deepEqual(audioToAudioEventTypes, [
  'input_speech_started', 'input_speech_ended', 'response_started', 'agent_audio',
  'response_completed', 'cancelled', 'usage', 'error',
]);
const registry = registerImplementedProviderAdapters(new ProviderAdapterRegistry());
assert.equal(registry.resolve('audio_to_audio', openAiConfig).key, 'openai-realtime');
assert.equal(registry.resolve('audio_to_audio', geminiConfig).key, 'gemini-live');
assert.equal(registry.resolve('audio_to_audio', novaConfig).key, 'amazon-nova-sonic');
assert.equal(registry.resolve('audio_to_audio', ultravoxConfig).key, 'ultravox');

console.log(JSON.stringify({ success: true, task: 'Audio-to-Audio provider adapter framework' }));
