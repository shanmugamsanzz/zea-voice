import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createCartesiaSttAdapter, resolveCartesiaSttConfiguration } = await import('../src/voice/providers/stt/cartesia.adapter.js');
const { createElevenLabsSttAdapter, resolveElevenLabsSttConfiguration } = await import('../src/voice/providers/stt/elevenlabs.adapter.js');
const { assertSttAdapter } = await import('../src/voice/providers/stt/stt.interface.js');
const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');
const { registerImplementedProviderAdapters } = await import('../src/voice/providers/defaults.js');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(message, options) {
    this.sent.push({ message, options });
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

function baseConfig(adapter, parameters, audio) {
  return {
    providerId: `${adapter}-provider`,
    providerName: adapter,
    providerSlug: adapter,
    baseUrl: `https://api.${adapter}.example`,
    modelId: `${adapter}-model`,
    modelKey: `${adapter}-realtime-model`,
    parameters,
    modelCapabilities: {
      runtime: { adapter, streaming: true, protocol: 'websocket' },
      audio: { input: audio },
    },
    effectiveSettings: { sttLanguage: 'ta-IN' },
  };
}

const cartesiaConfig = baseConfig('cartesia', { CARTESIA_API_KEY: 'cartesia-secret' }, {
  encoding: 'pcm_s16le', sampleRate: 16000, channels: 1,
});
const cartesiaSettings = resolveCartesiaSttConfiguration(cartesiaConfig);
const cartesiaUrl = new URL(cartesiaSettings.endpoint);
assert.equal(cartesiaUrl.protocol, 'wss:');
assert.equal(cartesiaUrl.pathname, '/stt/websocket');
assert.equal(cartesiaUrl.searchParams.get('model'), 'cartesia-realtime-model');
assert.equal(cartesiaUrl.searchParams.get('encoding'), 'pcm_s16le');
assert.equal(cartesiaUrl.searchParams.get('sample_rate'), '16000');
assert.equal(cartesiaUrl.searchParams.get('language'), 'ta');
assert.ok(!cartesiaSettings.endpoint.includes('cartesia-secret'));

let cartesiaSocket;
let cartesiaOptions;
const cartesia = assertSttAdapter(createCartesiaSttAdapter({
  providerConfig: cartesiaConfig,
  runtimeContext: {
    webSocketFactory(_url, options) {
      cartesiaOptions = options;
      cartesiaSocket = new FakeWebSocket();
      return cartesiaSocket;
    },
  },
}));
const cartesiaEvents = [];
cartesia.onEvent((event) => cartesiaEvents.push(event));
await cartesia.connect();
assert.equal(cartesiaOptions.headers['X-API-Key'], 'cartesia-secret');
const pcm = Buffer.alloc(640, 1);
cartesia.sendAudio(pcm);
assert.deepEqual(cartesiaSocket.sent[0], { message: pcm, options: { binary: true } });
cartesiaSocket.emit('message', Buffer.from(JSON.stringify({ type: 'transcript', text: 'வணக்கம்', request_id: 'cartesia-turn' })));
cartesiaSocket.emit('message', Buffer.from(JSON.stringify({ type: 'transcript', text: 'வணக்கம்', is_final: true, request_id: 'cartesia-turn' })));
assert.deepEqual(cartesiaEvents.map((event) => event.type), [
  'speech_started', 'partial_transcript', 'speech_ended', 'final_transcript', 'usage',
]);
assert.equal(cartesiaEvents.at(-1).audioBytes, 640);
assert.equal(cartesiaEvents.at(-1).audioDurationMs, 20);
cartesia.flush();
assert.equal(cartesiaSocket.sent.at(-1).message, 'finalize');
cartesiaSocket.emit('error', new Error('connection reset'));
assert.equal(cartesiaEvents.at(-1).type, 'error');
assert.equal(cartesiaEvents.at(-1).retryable, true);
cartesia.close();

const elevenConfig = baseConfig('elevenlabs', { ELEVENLABS_API_KEY: 'eleven-secret' }, {
  encoding: 'mulaw', sampleRate: 8000, channels: 1,
});
const elevenSettings = resolveElevenLabsSttConfiguration(elevenConfig);
const elevenUrl = new URL(elevenSettings.endpoint);
assert.equal(elevenUrl.protocol, 'wss:');
assert.equal(elevenUrl.pathname, '/v1/speech-to-text/realtime');
assert.equal(elevenUrl.searchParams.get('model_id'), 'elevenlabs-realtime-model');
assert.equal(elevenUrl.searchParams.get('audio_format'), 'ulaw_8000');
assert.equal(elevenUrl.searchParams.get('language_code'), 'ta');
assert.equal(elevenUrl.searchParams.get('commit_strategy'), 'manual');
assert.ok(!elevenSettings.endpoint.includes('eleven-secret'));

let elevenSocket;
let elevenOptions;
const eleven = assertSttAdapter(createElevenLabsSttAdapter({
  providerConfig: elevenConfig,
  runtimeContext: {
    webSocketFactory(_url, options) {
      elevenOptions = options;
      elevenSocket = new FakeWebSocket();
      return elevenSocket;
    },
  },
}));
const elevenEvents = [];
eleven.onEvent((event) => elevenEvents.push(event));
await eleven.connect();
assert.equal(elevenOptions.headers['xi-api-key'], 'eleven-secret');
const ulaw = Buffer.alloc(160, 2);
eleven.sendAudio(ulaw);
assert.deepEqual(JSON.parse(elevenSocket.sent[0].message), {
  message_type: 'input_audio_chunk', audio_base_64: ulaw.toString('base64'),
});
elevenSocket.emit('message', Buffer.from(JSON.stringify({ message_type: 'session_started', session_id: 'eleven-session' })));
elevenSocket.emit('message', Buffer.from(JSON.stringify({ message_type: 'partial_transcript', text: 'hello', session_id: 'eleven-session' })));
elevenSocket.emit('message', Buffer.from(JSON.stringify({ message_type: 'committed_transcript', text: 'hello world', session_id: 'eleven-session' })));
assert.deepEqual(elevenEvents.map((event) => event.type), [
  'speech_started', 'partial_transcript', 'speech_ended', 'final_transcript', 'usage',
]);
assert.equal(elevenEvents.at(-1).audioBytes, 160);
assert.equal(elevenEvents.at(-1).audioDurationMs, 20);
eleven.flush();
assert.deepEqual(JSON.parse(elevenSocket.sent.at(-1).message), {
  message_type: 'input_audio_chunk', audio_base_64: '', commit: true,
});
elevenSocket.emit('message', Buffer.from(JSON.stringify({ message_type: 'rate_limited', message: 'temporary capacity' })));
assert.equal(elevenEvents.at(-1).type, 'error');
assert.equal(elevenEvents.at(-1).retryable, true);
eleven.close();

assert.throws(
  () => resolveCartesiaSttConfiguration({ ...cartesiaConfig, parameters: {} }),
  (error) => error.code === 'STT_API_KEY_MISSING',
);
assert.throws(
  () => resolveElevenLabsSttConfiguration({ ...elevenConfig, parameters: {} }),
  (error) => error.code === 'STT_API_KEY_MISSING',
);

const registry = new ProviderAdapterRegistry();
registerImplementedProviderAdapters(registry);
assert.equal(registry.resolve('stt', cartesiaConfig).key, 'cartesia');
assert.equal(registry.resolve('stt', elevenConfig).key, 'elevenlabs');

console.log(JSON.stringify({ success: true, task: 'Cartesia and ElevenLabs streaming STT adapters' }));
