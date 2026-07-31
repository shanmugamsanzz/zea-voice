function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function rounded(value) { return Math.round(value * 100) / 100; }

export class TtsSpeedMonitor {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.minimumCharactersPerSecond = finitePositive(options.minimumCharactersPerSecond, 3);
    this.maximumCharactersPerSecond = finitePositive(options.maximumCharactersPerSecond, 28);
    this.minimumSampleCharacters = Math.max(1, Math.round(finitePositive(options.minimumSampleCharacters, 24)));
    this.minimumAudioMs = Math.max(1, Math.round(finitePositive(options.minimumAudioMs, 500)));
    if (this.minimumCharactersPerSecond >= this.maximumCharactersPerSecond) {
      throw new TypeError('Minimum TTS speed must be lower than maximum TTS speed');
    }
  }

  inspect(input = {}) {
    const characters = Math.max(0, Number(input.characters)
      || Array.from(String(input.text ?? '')).length);
    const audioOutputMs = Math.max(0, Number(input.audioOutputMs) || 0);
    const eligible = this.enabled
      && characters >= this.minimumSampleCharacters
      && audioOutputMs >= this.minimumAudioMs;
    const charactersPerSecond = audioOutputMs > 0
      ? characters / (audioOutputMs / 1000) : null;
    let classification = 'not_measured';
    if (eligible) {
      if (charactersPerSecond > this.maximumCharactersPerSecond) classification = 'too_fast';
      else if (charactersPerSecond < this.minimumCharactersPerSecond) classification = 'too_slow';
      else classification = 'normal';
    }
    return Object.freeze({
      measured: eligible,
      abnormal: classification === 'too_fast' || classification === 'too_slow',
      classification,
      characters,
      audioOutputMs,
      charactersPerSecond: charactersPerSecond === null ? null : rounded(charactersPerSecond),
      expectedMinimum: this.minimumCharactersPerSecond,
      expectedMaximum: this.maximumCharactersPerSecond,
    });
  }
}

export function createTtsSpeedMonitor(options = {}) {
  return new TtsSpeedMonitor(options);
}
