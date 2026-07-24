const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu;

function tokens(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().match(wordPattern) ?? [];
}

function containsPhrase(source, phrase) {
  if (!phrase.length || phrase.length > source.length) return false;
  return source.some((_, index) => phrase.every((word, offset) => source[index + offset] === word));
}

export class InterruptionCandidateManager {
  constructor({ configuration, onConfirm = () => {}, onReject = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.configuration = configuration;
    this.onConfirm = onConfirm;
    this.onReject = onReject;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.reset();
  }

  get active() { return this.startedAt !== null; }
  get confirmed() { return this.confirmedBy !== null; }

  start() {
    if (this.active) return this.snapshot();
    this.startedAt = this.now();
    if (this.configuration.timeBased.enabled) {
      this.timer = this.setTimer(() => this.#evaluate('time'), this.configuration.timeBased.thresholdMs);
      this.timer?.unref?.();
    }
    return this.snapshot();
  }

  observeTranscript(text) {
    if (!this.active) this.start();
    const transcriptTokens = tokens(text);
    this.wordCount = transcriptTokens.length;
    this.matchedTrigger = this.configuration.wordBased.triggerWords.find((trigger) => (
      containsPhrase(transcriptTokens, tokens(trigger))
    )) ?? null;
    return this.#evaluate(this.matchedTrigger ? 'trigger_word' : 'minimum_words');
  }

  finish(reason = 'speech_ended') {
    if (!this.active || this.confirmed) return this.snapshot();
    const result = this.#evaluate('speech_ended');
    if (!result.confirmed) {
      this.onReject({ ...result, reason });
      this.reset();
    }
    return result;
  }

  reset() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.startedAt = null;
    this.wordCount = 0;
    this.matchedTrigger = null;
    this.confirmedBy = null;
  }

  snapshot() {
    return {
      active: this.active,
      confirmed: this.confirmed,
      confirmedBy: this.confirmedBy,
      elapsedMs: this.active ? Math.max(0, this.now() - this.startedAt) : 0,
      wordCount: this.wordCount,
      matchedTrigger: this.matchedTrigger,
    };
  }

  #evaluate(source) {
    if (!this.active || this.confirmed) return this.snapshot();
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    const timePassed = this.configuration.timeBased.enabled
      && elapsedMs >= this.configuration.timeBased.thresholdMs;
    const wordPassed = this.configuration.wordBased.enabled
      && (this.wordCount >= this.configuration.wordBased.minimumWords || Boolean(this.matchedTrigger));
    const enabledChecks = [
      ...(this.configuration.timeBased.enabled ? [timePassed] : []),
      ...(this.configuration.wordBased.enabled ? [wordPassed] : []),
    ];
    const passed = enabledChecks.length > 0 && (
      this.configuration.policy === 'all' ? enabledChecks.every(Boolean) : enabledChecks.some(Boolean)
    );
    if (passed) {
      this.confirmedBy = this.matchedTrigger ? 'trigger_word' : source;
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      const result = { ...this.snapshot(), timePassed, wordPassed };
      this.onConfirm(result);
      return result;
    }
    return { ...this.snapshot(), timePassed, wordPassed };
  }
}

