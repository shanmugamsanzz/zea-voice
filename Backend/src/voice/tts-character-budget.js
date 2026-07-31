import { AppError } from '../middleware/errors.js';

const windowMs = 60_000;
const terminalPunctuation = /[.!?\u2026\u0964\u3002\uff01\uff1f]["'\u201d\u2019)\]]*$/u;

export function spokenCharacterCount(value) {
  return Array.from(String(value ?? '')).length;
}

function sentenceSegments(text, locale) {
  try {
    return [...new Intl.Segmenter(locale || 'und', { granularity: 'sentence' }).segment(text)]
      .map((entry) => entry.segment.trim()).filter(Boolean);
  } catch {
    return String(text ?? '').trim()
      .split(/(?<=[.!?\u2026\u0964\u3002\uff01\uff1f])\s+/u).filter(Boolean);
  }
}

export function completeSentencePrefix(text, maximumCharacters, locale = 'und') {
  const segments = sentenceSegments(String(text ?? '').trim(), locale);
  let output = '';
  for (const sentence of segments) {
    if (!terminalPunctuation.test(sentence)) break;
    const candidate = output ? `${output} ${sentence}` : sentence;
    if (spokenCharacterCount(candidate) > maximumCharacters) break;
    output = candidate;
  }
  return output;
}

export class TtsCharacterBudget {
  #entries = [];

  constructor(maximumCharactersPerMinute = 0, options = {}) {
    this.maximum = Number(maximumCharactersPerMinute) || 0;
    this.now = options.now ?? Date.now;
  }

  get enabled() { return this.maximum > 0; }

  #prune(now) {
    this.#entries = this.#entries.filter((entry) => entry.at > now - windowMs);
  }

  usage(now = this.now()) {
    this.#prune(now);
    const used = this.#entries.reduce((total, entry) => total + entry.characters, 0);
    return Object.freeze({
      enabled: this.enabled,
      maximum: this.maximum,
      used,
      remaining: this.enabled ? Math.max(0, this.maximum - used) : null,
    });
  }

  fitMessage(text, fallback = '', options = {}) {
    const normalized = String(text ?? '').trim();
    const maximum = Number(options.maximumCharacters ?? this.maximum) || 0;
    if (maximum <= 0 || spokenCharacterCount(normalized) <= maximum) return normalized;
    const prefix = completeSentencePrefix(normalized, maximum, options.locale);
    if (prefix) return prefix;
    const safeFallback = String(fallback ?? '').trim();
    if (safeFallback && terminalPunctuation.test(safeFallback)
      && spokenCharacterCount(safeFallback) <= maximum) return safeFallback;
    throw new AppError(409,
      'Spoken message exceeds the configured TTS character limit and has no complete sentence that fits',
      'VOICE_TTS_MESSAGE_LIMIT_EXCEEDED', { maximumCharacters: maximum });
  }

  inspect(text, now = this.now()) {
    const characters = spokenCharacterCount(text);
    if (!this.enabled) return Object.freeze({ allowed: true, characters, waitMs: 0 });
    if (characters > this.maximum) {
      return Object.freeze({ allowed: false, impossible: true, characters, waitMs: null });
    }
    const current = this.usage(now);
    if (characters <= current.remaining) {
      return Object.freeze({ allowed: true, characters, waitMs: 0 });
    }
    const oldest = this.#entries[0];
    return Object.freeze({
      allowed: false,
      impossible: false,
      characters,
      waitMs: Math.max(1, (oldest?.at ?? now) + windowMs - now),
    });
  }

  consume(text, now = this.now()) {
    const decision = this.inspect(text, now);
    if (!decision.allowed) return decision;
    if (this.enabled && decision.characters > 0) this.#entries.push({ at: now, characters: decision.characters });
    return Object.freeze({ ...decision, ...this.usage(now) });
  }
}
