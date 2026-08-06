const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu;

function tokens(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().match(wordPattern) ?? [];
}

function containsPhrase(source, phrase) {
  if (!phrase.length || phrase.length > source.length) return false;
  return source.some((_, index) => phrase.every((word, offset) => source[index + offset] === word));
}

function phraseMatches(source, phrases) {
  return phrases
    .map((phrase) => ({ phrase, tokens: tokens(phrase) }))
    .filter(({ tokens: phraseTokens }) => phraseTokens.length > 0 && containsPhrase(source, phraseTokens));
}

function acknowledgementOnly(source, phrases) {
  if (!source.length) return false;
  const covered = new Array(source.length).fill(false);
  for (const { tokens: phraseTokens } of phraseMatches(source, phrases)) {
    for (let index = 0; index <= source.length - phraseTokens.length; index += 1) {
      if (!phraseTokens.every((word, offset) => source[index + offset] === word)) continue;
      for (let offset = 0; offset < phraseTokens.length; offset += 1) covered[index + offset] = true;
    }
  }
  return covered.every(Boolean);
}

// These phrases ask the agent to repeat or explain something; they are not
// requests to pause audio.  A tenant may have saved one of them in an older
// "stop phrase" list, so protect the live conversation from that legacy
// configuration rather than dropping a valid customer question.
function isRepeatOrExplanationPhrase(phrase) {
  return /(?:மறுபடியும்|மீண்டும்|சொல்லுங்க|சொல்லு|விளக்க|repeat|again|explain)/iu
    .test(String(phrase ?? '').normalize('NFKC'));
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
    this.matchedTrigger = phraseMatches(transcriptTokens, this.configuration.explicitStopPhrases)
      .filter(({ phrase }) => !isRepeatOrExplanationPhrase(phrase))
      .map(({ phrase }) => phrase)[0] ?? null;
    this.classification = !transcriptTokens.length
      ? 'empty'
      : this.matchedTrigger
        ? 'explicit_stop'
        : acknowledgementOnly(transcriptTokens, this.configuration.acknowledgementPhrases)
          ? 'acknowledgement'
          : 'meaningful';
    this.stopPhraseOnly = this.classification === 'explicit_stop'
      && acknowledgementOnly(transcriptTokens, [this.matchedTrigger]);
    if (this.classification === 'acknowledgement') return this.snapshot();
    return this.#evaluate(this.classification === 'explicit_stop' ? 'explicit_stop' : 'minimum_words');
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
    this.classification = 'empty';
    this.stopPhraseOnly = false;
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
      classification: this.classification,
      stopPhraseOnly: this.stopPhraseOnly,
    };
  }

  #evaluate(source) {
    if (!this.active || this.confirmed) return this.snapshot();
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    const timePassed = this.configuration.timeBased.enabled
      && elapsedMs >= this.configuration.timeBased.thresholdMs;
    const wordPassed = this.configuration.wordBased.enabled
      && (this.wordCount >= this.configuration.wordBased.minimumWords || Boolean(this.matchedTrigger));

    // A timer is now a confirmation delay, never independent evidence. This
    // prevents a fan, car, breathing, or an empty STT event from cancelling
    // the agent merely because the delay elapsed.
    // A stop phrase is text-confirmed evidence and may stop active TTS at
    // once. Normal customer speech still needs both meaningful text and the
    // configured confirmation delay.
    const passed = this.classification === 'explicit_stop'
      ? Boolean(this.matchedTrigger)
      : Boolean(timePassed && wordPassed);
    if (passed) {
      this.confirmedBy = this.matchedTrigger ? 'explicit_stop_phrase' : source;
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      const result = { ...this.snapshot(), timePassed, wordPassed };
      this.onConfirm(result);
      return result;
    }
    return { ...this.snapshot(), timePassed, wordPassed };
  }
}

