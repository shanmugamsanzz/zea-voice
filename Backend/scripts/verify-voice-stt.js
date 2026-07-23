import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { createSarvamSttAdapter, resolveSarvamSttConfiguration } = await import('../src/voice/providers/stt/sarvam.adapter.js');
const { assertSttAdapter, sttEventTypes } = await import('../src/voice/providers/stt/stt.interface.js');
const { ProviderAdapterRegistry } = await import('../src/voice/providers/registry.js');
const { registerImplementedProviderAdapters } = await import('../src/voice/providers/defaults.js');

const providerConfig = {
  providerId: 'sarvam-provider',
  providerName: 'Sarvam',
  providerSlug: 'sarvam',
  baseUrl: 'https://api.sarvam.ai',
  modelId: 'saaras-model',
  modelKey: 'saaras:v3',
  modelCapabilities: {
    runtime: { adapter: 'sarvam', streaming: true, protocol: 'websocket' },
    audio: { input: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } },
  },
  effectiveSettings: {
    sttLanguage: 'ta-IN',
    sarvamMode: 'transcribe',
    sttHighVadSensitivity: false,
    sttVadSignals: true,
    sttFlushSignal: true,
    sttPositiveSpeechThreshold: 0.75,
  },
  parameters: { SARVAM_API_KEY: 'database-secret' },
};

const configuration = resolveSarvamSttConfiguration(providerConfig);
const endpoint = new URL(configuration.endpoint);
assert.equal(endpoint.protocol, 'wss:');
assert.equal(endpoint.pathname, '/speech-to-text/ws');
assert.equal(endpoint.searchParams.get('language-code'), 'ta-IN');
assert.equal(endpoint.searchParams.get('model'), 'saaras:v3');
assert.equal(endpoint.searchParams.get('sample_rate'), '16000');
assert.equal(endpoint.searchParams.get('input_audio_codec'), 'pcm_s16le');
assert.equal(configuration.messageEncoding, 'audio/wav');
assert.equal(endpoint.searchParams.get('high_vad_sensitivity'), 'false');
assert.equal(endpoint.searchParams.get('positive_speech_threshold'), '0.75');
assert.ok(!configuration.endpoint.includes('database-secret'));

const parameterStyleConfiguration = resolveSarvamSttConfiguration({
  ...providerConfig,
  modelCapabilities: { runtime: { adapter: 'sarvam', streaming: true } },
  effectiveSettings: {
    SARVAM_INPUT_AUDIO_CODEC: 'pcm_s16le',
    SARVAM_SAMPLE_RATE: '8000',
    SARVAM_LANGUAGE_CODE: 'en-IN',
    SARVAM_HIGH_VAD_SENSITIVITY: 'true',
  },
});
assert.equal(parameterStyleConfiguration.audioFormat.sampleRate, 8000);
assert.equal(parameterStyleConfiguration.language, 'en-IN');

const legacyLabelConfiguration = resolveSarvamSttConfiguration({
  ...providerConfig,
  effectiveSettings: { ...providerConfig.effectiveSettings, sttLanguage: 'Tamil (India) (ta-IN)' },
});
assert.equal(legacyLabelConfiguration.language, 'ta-IN');
assert.throws(
  () => resolveSarvamSttConfiguration({
    ...providerConfig,
    effectiveSettings: { ...providerConfig.effectiveSettings, sttLanguage: 'en-US' },
  }),
  (error) => error.code === 'STT_LANGUAGE_UNSUPPORTED',
);

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(message) { this.sent.push(JSON.parse(message)); }
  close(code, reason) { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
  terminate() { this.readyState = 3; }
}

let socket;
let connectionOptions;
const adapter = assertSttAdapter(createSarvamSttAdapter({
  providerConfig,
  runtimeContext: {
    webSocketFactory(url, options) {
      assert.equal(url, configuration.endpoint);
      connectionOptions = options;
      socket = new FakeWebSocket();
      return socket;
    },
  },
}));
const events = [];
adapter.onEvent((event) => events.push(event));
await adapter.connect();
assert.equal(connectionOptions.headers['Api-Subscription-Key'], 'database-secret');

const pcm = Buffer.alloc(640, 1);
adapter.sendAudio(pcm);
assert.equal(socket.sent[0].audio.sample_rate, '16000');
assert.equal(socket.sent[0].audio.encoding, 'audio/wav');
assert.deepEqual(Buffer.from(socket.sent[0].audio.data, 'base64'), pcm);

socket.emit('message', Buffer.from(JSON.stringify({ type: 'events', data: { signal_type: 'START_SPEECH' } })));
socket.emit('message', Buffer.from(JSON.stringify({
  type: 'partial', data: { transcript: 'வணக்', is_final: false, request_id: 'request-1' },
})));
socket.emit('message', Buffer.from(JSON.stringify({
  type: 'data', data: {
    transcript: 'வணக்கம்', request_id: 'request-1',
    metrics: { audio_duration: 0.02, processing_latency: 0.07 },
  },
})));
socket.emit('message', Buffer.from(JSON.stringify({ type: 'events', data: { signal_type: 'END_SPEECH' } })));

assert.deepEqual(events.map((event) => event.type), [
  'speech_started', 'partial_transcript', 'final_transcript', 'usage', 'speech_ended',
]);
assert.equal(events[1].isFinal, false);
assert.equal(events[2].text, 'வணக்கம்');
assert.equal(events[2].language, 'ta-IN');
assert.equal(events[3].audioDurationMs, 20);
assert.equal(events[3].processingLatencyMs, 70);
assert.equal(events[3].audioBytes, 640);
assert.ok(events.every((event, index) => event.sequence === index + 1));

adapter.flush();
assert.deepEqual(socket.sent.at(-1), { type: 'flush' });
adapter.cancel('test-complete');
adapter.close();

assert.deepEqual(sttEventTypes, [
  'speech_started', 'partial_transcript', 'final_transcript', 'speech_ended', 'usage', 'error',
]);

const registry = new ProviderAdapterRegistry();
registerImplementedProviderAdapters(registry);
assert.equal(registry.resolve('stt', providerConfig).key, 'sarvam');
assert.throws(
  () => resolveSarvamSttConfiguration({ ...providerConfig, parameters: {} }),
  (error) => error.code === 'STT_API_KEY_MISSING',
);
assert.throws(
  () => resolveSarvamSttConfiguration({
    ...providerConfig,
    modelCapabilities: { ...providerConfig.modelCapabilities, audio: { input: { encoding: 'mulaw', sampleRate: 8000 } } },
  }),
  (error) => error.code === 'STT_AUDIO_FORMAT_UNSUPPORTED',
);

console.log(JSON.stringify({ success: true, task: 'Streaming STT - Sarvam normalized adapter' }));
