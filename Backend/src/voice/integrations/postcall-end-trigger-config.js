const maxPhrases = 50;
const maxPhraseLength = 160;

// These are retained only for agents that have not configured their own list.
// A configured list deliberately replaces these defaults so every company can
// control its own language and call-ending policy.
export const defaultCallEndTriggerPhrases = Object.freeze([
  'bye', 'goodbye', 'hang up', 'disconnect', 'end call', 'end the call',
  'not interested', 'call me later', "i'm busy", 'i am busy',
  'போதும்', 'அழைப்பை முடி', 'பிறகு அழைக்கவும்',
]);

function configurationError(message, field = 'callEndTriggerPhrases') {
  return Object.assign(new TypeError(message), {
    code: 'POSTCALL_END_TRIGGER_CONFIGURATION_INVALID', field,
  });
}

function canonicalPhrase(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
}

function isWordCharacter(value) {
  return Boolean(value) && /[\p{L}\p{N}_]/u.test(value);
}

function containsWholePhrase(text, phrase) {
  let start = text.indexOf(phrase);
  while (start >= 0) {
    const end = start + phrase.length;
    if (!isWordCharacter(text[start - 1]) && !isWordCharacter(text[end])) return true;
    start = text.indexOf(phrase, start + 1);
  }
  return false;
}

/**
 * Resolves the developer-managed phrases that indicate a caller wants to end
 * a call. Matching is intentionally not implemented here; this module only
 * owns validation and the persisted agent configuration.
 */
export function resolvePostCallEndTriggerConfiguration(settings = {}, { strict = false } = {}) {
  const value = settings.callEndTriggerPhrases;
  if (value === undefined || value === null) return Object.freeze({ phrases: Object.freeze([]) });
  if (!Array.isArray(value)) {
    if (strict) throw configurationError('Call End Trigger Phrases must be a list of phrases');
    return Object.freeze({ phrases: Object.freeze([]) });
  }
  if (value.length > maxPhrases) {
    throw configurationError(`Call End Trigger Phrases cannot contain more than ${maxPhrases} phrases`);
  }

  const phrases = [];
  const seen = new Set();
  for (const entry of value) {
    const phrase = canonicalPhrase(entry);
    if (!phrase) continue;
    if (phrase.length > maxPhraseLength) {
      throw configurationError(`Each Call End Trigger Phrase cannot exceed ${maxPhraseLength} characters`);
    }
    const duplicateKey = phrase.toLocaleLowerCase();
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    phrases.push(phrase);
  }
  return Object.freeze({ phrases: Object.freeze(phrases) });
}

export function normalizePostCallEndTriggerSettings(settings = {}) {
  const configuration = resolvePostCallEndTriggerConfiguration(settings, { strict: true });
  return {
    ...settings,
    callEndTriggerPhrases: [...configuration.phrases],
  };
}

export function resolveCallEndTriggerPhrases(settings = {}) {
  const configured = resolvePostCallEndTriggerConfiguration(settings).phrases;
  return Object.freeze({
    source: configured.length > 0 ? 'agent' : 'default',
    phrases: configured.length > 0 ? configured : defaultCallEndTriggerPhrases,
  });
}

/**
 * Finds one configured phrase in a final STT utterance. Boundary-aware literal
 * matching prevents short phrases such as "bye" from matching inside another
 * word, while supporting Tamil, English and Tanglish without regex escaping.
 */
export function findCallEndTriggerPhrase(transcript, settings = {}) {
  const text = canonicalPhrase(transcript).toLocaleLowerCase();
  if (!text) return null;
  const configuration = resolveCallEndTriggerPhrases(settings);
  for (const entry of configuration.phrases) {
    const phrase = canonicalPhrase(entry).toLocaleLowerCase();
    if (phrase && containsWholePhrase(text, phrase)) {
      return Object.freeze({ phrase: entry, source: configuration.source });
    }
  }
  return null;
}

export function classifyFinalCallEndUtterance(transcript, settings = {}, { finalized = false } = {}) {
  if (!finalized) return Object.freeze({ matchedPhrase: null, shortcut: false, source: null });
  const match = findCallEndTriggerPhrase(transcript, settings);
  if (!match) return Object.freeze({ matchedPhrase: null, shortcut: false, source: null });
  return Object.freeze({
    matchedPhrase: match.phrase,
    source: match.source,
    // A phrase embedded in a larger finalized request is not a control turn.
    // The complete utterance continues to the unified grounded decision.
    shortcut: canonicalPhrase(transcript).toLocaleLowerCase()
      === canonicalPhrase(match.phrase).toLocaleLowerCase(),
  });
}
