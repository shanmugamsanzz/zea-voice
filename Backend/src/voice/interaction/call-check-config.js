export const maximumCallCheckPhrases = 20;
export const maximumCallCheckPhraseLength = 100;
export const maximumCallCheckResponseLength = 500;

function configurationError(message, field) {
  return Object.assign(new TypeError(message), {
    code: 'CALL_CHECK_CONFIGURATION_INVALID', field,
  });
}

function text(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function comparable(value) {
  return text(value)
    .toLocaleLowerCase()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
    .trim();
}

export function resolveCallCheckConfiguration(settings = {}, { strict = false } = {}) {
  const input = settings.callCheckPhrases ?? [];
  if (!Array.isArray(input)) {
    if (strict) throw configurationError('Call Check Phrases must be a list of phrases', 'callCheckPhrases');
    return Object.freeze({ phrases: Object.freeze([]), response: '' });
  }
  if (input.length > maximumCallCheckPhrases) {
    throw configurationError(`Call Check Phrases cannot contain more than ${maximumCallCheckPhrases} phrases`, 'callCheckPhrases');
  }

  const phrases = [];
  const seen = new Set();
  for (const rawPhrase of input) {
    const phrase = text(rawPhrase);
    if (!phrase) continue;
    if (Array.from(phrase).length > maximumCallCheckPhraseLength) {
      throw configurationError(`Each Call Check Phrase cannot exceed ${maximumCallCheckPhraseLength} characters`, 'callCheckPhrases');
    }
    const key = comparable(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }

  const response = text(settings.callCheckResponse);
  if (Array.from(response).length > maximumCallCheckResponseLength) {
    throw configurationError(`Call Check Response cannot exceed ${maximumCallCheckResponseLength} characters`, 'callCheckResponse');
  }
  if (phrases.length && !response) {
    throw configurationError('Call Check Response is required when Call Check Phrases are configured', 'callCheckResponse');
  }
  return Object.freeze({ phrases: Object.freeze(phrases), response });
}

export function normalizeCallCheckSettings(settings = {}) {
  const configuration = resolveCallCheckConfiguration(settings, { strict: true });
  return {
    ...settings,
    callCheckPhrases: [...configuration.phrases],
    callCheckResponse: configuration.response,
  };
}

export function findCallCheckPhrase(transcript, configuration) {
  const source = comparable(transcript);
  if (!source || !configuration?.response) return null;
  for (const phrase of configuration.phrases ?? []) {
    if (source === comparable(phrase)) return phrase;
  }
  return null;
}

export function findCallCheckPhraseCandidate(transcript, configuration) {
  const source = comparable(transcript);
  if (!source || !configuration?.response) return null;
  for (const phrase of configuration.phrases ?? []) {
    const candidate = comparable(phrase);
    if (candidate && source.includes(candidate)) return phrase;
  }
  return null;
}

// A call-check response is a deterministic shortcut only for a complete
// utterance that consists of the configured presence phrase.  Keeping this
// predicate configuration-based prevents a phrase embedded in a real request
// from consuming that request (for example, "Hello, what options are there?").
export function isCallCheckOnlyUtterance(transcript, matchedPhrase, configuration) {
  if (!matchedPhrase || !configuration?.response) return false;
  return comparable(transcript) === comparable(matchedPhrase);
}

export function classifyFinalCallCheckUtterance(transcript, configuration, { finalized = false } = {}) {
  if (!finalized) return Object.freeze({ matchedPhrase: null, shortcut: false });
  const matchedPhrase = findCallCheckPhraseCandidate(transcript, configuration);
  return Object.freeze({
    matchedPhrase,
    shortcut: isCallCheckOnlyUtterance(transcript, matchedPhrase, configuration),
  });
}
