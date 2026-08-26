import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserTestWebsocketUrl, linearToMuLaw, muLawToLinear, resampleToMuLaw,
} from '../src/lib/browserAgentMedia';

const session = {
  testCallId: 'test-call', callId: 'test-call', token: 'signed-token',
  mediaPath: '/voice/browser-test/media', protocol: 'zea.browser-voice.v1',
  expiresAt: '2026-08-26T12:00:00.000Z',
};

test('browser test websocket preserves the API proxy prefix', () => {
  assert.equal(
    browserTestWebsocketUrl('/api', session, 'https://voice.example.com'),
    'wss://voice.example.com/api/voice/browser-test/media?call_id=test-call&token=signed-token',
  );
  assert.equal(
    browserTestWebsocketUrl('https://api.example.com', session, 'https://voice.example.com'),
    'wss://api.example.com/voice/browser-test/media?call_id=test-call&token=signed-token',
  );
});

test('browser microphone PCM is converted to 8 kHz mu-law deterministically', () => {
  const source = new Float32Array(480);
  for (let index = 0; index < source.length; index += 1) {
    source[index] = Math.sin((2 * Math.PI * 440 * index) / 48_000) * 0.4;
  }
  const encoded = resampleToMuLaw(source, 48_000);
  assert.equal(encoded.length, 80, '10 ms at 48 kHz must become 10 ms at 8 kHz');
  assert.ok(new Set(encoded).size > 8, 'speech waveform must not collapse to silence');
  assert.ok(encoded.every((sample) => Number.isInteger(sample) && sample >= 0 && sample <= 255));
});

test('mu-law conversion preserves silence and signal polarity', () => {
  assert.equal(linearToMuLaw(0), 0xff);
  assert.ok(muLawToLinear(linearToMuLaw(0.5)) > 0);
  assert.ok(muLawToLinear(linearToMuLaw(-0.5)) < 0);
  assert.ok(Math.abs(muLawToLinear(linearToMuLaw(0.5)) - 0.5) < 0.08);
});

test('invalid or empty microphone buffers produce no transport audio', () => {
  assert.equal(resampleToMuLaw(new Float32Array(), 48_000).length, 0);
  assert.equal(resampleToMuLaw(new Float32Array([0.2]), 0).length, 0);
});
