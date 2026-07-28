import assert from 'node:assert/strict';
import { createTtsSpeedMonitor } from '../src/voice/tts-speed-monitor.js';

const monitor = createTtsSpeedMonitor({
  minimumCharactersPerSecond: 3,
  maximumCharactersPerSecond: 28,
  minimumSampleCharacters: 24,
  minimumAudioMs: 500,
});

assert.equal(monitor.inspect({ characters: 100, audioOutputMs: 7000 }).classification, 'normal');
assert.equal(monitor.inspect({ characters: 105, audioOutputMs: 3358 }).classification, 'too_fast');
assert.equal(monitor.inspect({ characters: 100, audioOutputMs: 40_000 }).classification, 'too_slow');
assert.equal(monitor.inspect({ characters: 10, audioOutputMs: 300 }).classification, 'not_measured');

console.log(JSON.stringify({ success: true, task: 'TTS abnormal-speed detection' }));
