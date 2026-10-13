import assert from 'node:assert/strict';
import { hasSpeakableText } from '../src/voice/tts-speakable-text.js';
import { resolveConfiguredLatencyAcknowledgement, armTemplateEngineTurnLatencyAcknowledgement }
  from '../src/voice/interaction/template-engine-turn-latency.js';

for (const value of ['', '   ', '...', '?!—', '\u200b', '🙂', null]) {
  assert.equal(hasSpeakableText(value), false);
  assert.equal(resolveConfiguredLatencyAcknowledgement({ configuredText: value }).text, '');
  let armed = false;
  const timer = armTemplateEngineTurnLatencyAcknowledgement({
    acknowledgementText: value, thresholdMs: 750, onAcknowledgement: () => true,
    setTimer: () => { armed = true; return 1; }, clearTimer: () => {},
  });
  assert.equal(armed, false);
  assert.equal(timer.snapshot().enabled, false);
}
for (const value of ['சரி', 'Sari nga.', 'ठीक है', 'ٹھیک ہے', '好的', '2 minutes', '350']) {
  assert.equal(hasSpeakableText(value), true);
  assert.equal(resolveConfiguredLatencyAcknowledgement({ configuredText: value }).text, value);
}
console.log('Multilingual TTS content and acknowledgement timer checks passed');
