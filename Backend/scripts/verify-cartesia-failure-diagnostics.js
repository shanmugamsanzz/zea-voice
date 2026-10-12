import assert from 'node:assert/strict';
import { createCartesiaTtsAdapter } from '../src/voice/providers/tts/cartesia.adapter.js';
import { sanitizeTtsProviderMessage } from '../src/voice/providers/tts/provider-diagnostics.js';

const key = 'test-cartesia-credential';
const transcript = 'Private patient speech '.repeat(40);
const providerConfig = {
  providerId: 'cartesia', modelId: 'test-model', modelKey: 'sonic-3',
  baseUrl: 'https://api.cartesia.ai',
  effectiveSettings: { voiceId: 'voice-test', ttsLanguage: 'ta', ttsSpeed: 0.9 },
  modelCapabilities: { audio: { output: { encoding: 'mulaw', sampleRate: 8000, channels: 1 } } },
  parameters: { CARTESIA_API_KEY: key, CARTESIA_VERSION: '2026-03-01' },
};
for (const status of [400, 401, 429]) {
  const logs = [];
  const adapter = createCartesiaTtsAdapter({ providerConfig, runtimeContext: {
    log: { error: (fields) => logs.push(fields) },
    fetch: async (_url, options) => {
      assert.equal(JSON.parse(options.body).generation_config.speed, 0.9);
      return new Response(JSON.stringify({ error: `Invalid setting; credential ${key}; ${transcript}` }), { status });
    },
  } });
  const events = [];
  for await (const event of adapter.synthesizeStream({ text: transcript })) events.push(event);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).message, 'Selected TTS provider request failed');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerStatus, status);
  assert.equal(logs[0].speed, 0.9);
  assert.equal(logs[0].modelKey, 'sonic-3');
  assert.match(logs[0].providerMessage, /Invalid setting/);
  assert.doesNotMatch(JSON.stringify(logs), /test-cartesia-credential|Private patient speech/);
  assert.ok(logs[0].providerMessage.length <= 500);
}
const logs = [];
const adapter = createCartesiaTtsAdapter({ providerConfig, runtimeContext: {
  log: { error: (fields) => logs.push(fields) },
  fetch: async () => new Response(`data: ${JSON.stringify({ type: 'error', status_code: 400, message: `Unsupported setting ${key}` })}\n\n`, { status: 200 }),
} });
for await (const event of adapter.synthesizeStream({ text: transcript })) {
  assert.equal(event.type, 'error');
  assert.equal(event.message, 'Cartesia synthesis failed');
}
assert.equal(logs[0].providerStatus, 400);
assert.match(logs[0].providerMessage, /Unsupported setting/);
assert.ok(!JSON.stringify(logs).includes(key));
const sanitized = sanitizeTtsProviderMessage('Bearer abc-secret "api_key":"other-secret" "transcript":"private speech" https://example.com/?token=secret test@example.com +919360235493');
assert.doesNotMatch(sanitized, /abc-secret|other-secret|private speech|example.com|9360235493/);
console.log('Cartesia HTTP/SSE failure diagnostics, speed 0.9 and redaction checks passed.');
