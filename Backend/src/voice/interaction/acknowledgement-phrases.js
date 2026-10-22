import { normalizeResponseLanguage } from './response-language.js';

export function validateAcknowledgementSettings(settings = {}) {
  for (const key of ['latencySingleEnabled', 'latencyMultipleEnabled']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error(key + ' must be boolean');
  }
  if (settings.latencySingleEnabled !== false && settings.latencyMultipleEnabled === true) throw new Error('Enable only one acknowledgement mode');
  const interval = settings.latencyPhraseInterval ?? 2;
  if (interval !== 'random' && (!Number.isInteger(interval) || interval < 1 || interval > 20)) throw new Error('Acknowledgement interval must be 1 to 20 or random');
  const groups = settings.latencyPhraseGroups ?? [];
  if (!Array.isArray(groups) || groups.length > 10) throw new Error('Maximum 10 acknowledgement language groups');
  const languages = new Set();
  for (const group of groups) {
    const language = normalizeResponseLanguage(group?.language);
    if (!language || languages.has(language)) throw new Error('Each acknowledgement group needs a unique language');
    languages.add(language);
    if (!Array.isArray(group.phrases) || group.phrases.length > 20 || group.phrases.some(p => typeof p !== 'string' || !p.trim() || p.length > 200)) throw new Error('Use 1 to 20 nonempty phrases of at most 200 characters per language');
    if (!group.phrases.length) throw new Error('Each language group requires a phrase');
  }
  if (settings.latencyMultipleEnabled === true && !groups.length) throw new Error('Multiple acknowledgements require a language group');
  return settings;
}

// Instantiate once per call. Never share counters or selected text across calls.
export function createAcknowledgementPhraseSelector(random = Math.random) {
  let searches = 0;
  const last = new Map();
  return {
    prepare(settings = {}, language, singleText = '') {
      const multiple = settings.latencyMultipleEnabled === true;
      const code = normalizeResponseLanguage(language);
      const group = (Array.isArray(settings.latencyPhraseGroups) ? settings.latencyPhraseGroups : [])
        .find(g => normalizeResponseLanguage(g.language) === code);
      const phrases = [...new Set((group?.phrases ?? []).filter(p => typeof p === 'string' && p.trim()).map(p => p.trim().slice(0,200)))];
      const choices = phrases.length > 1 ? phrases.filter(p => p !== last.get(code)) : phrases;
      const text = multiple ? (choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] || '')
        : settings.latencySingleEnabled === false ? '' : singleText;
      let eligible;
      return {
        text,
        eligibleSearch() {
          if (eligible !== undefined) return eligible;
          if (!multiple) return (eligible = Boolean(text));
          searches += 1;
          const interval = settings.latencyPhraseInterval ?? 2;
          eligible = Boolean(text) && (interval === 'random' ? random() < 0.5 : searches % interval === 0);
          return eligible;
        },
        markQueued() { if (multiple && text) last.set(code, text); },
      };
    },
  };
}
