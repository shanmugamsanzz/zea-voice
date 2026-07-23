const templatePattern = /{{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*}}/g;
const unresolvedSentencePattern = /[^.!?।\n]*{{\s*[A-Za-z][A-Za-z0-9_.-]{0,63}\s*}}[^.!?।\n]*(?:[.!?।]+|$)/g;

function readPath(value, path) {
  return String(path).split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function boundedText(value, maxCharacters = 120) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  const normalized = String(value).normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.includes('{{') || normalized.includes('}}')) return null;
  return Array.from(normalized).slice(0, maxCharacters).join('');
}

function safeTemplateValue(key, value) {
  const text = boundedText(value);
  if (!text) return null;
  if (key === 'customer_name' || key === 'lead_name') {
    return /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’\-]{0,119}$/u.test(text) ? text : null;
  }
  return text;
}

function genericHelp(language) {
  const normalized = String(language ?? '').toLowerCase();
  if (normalized.startsWith('ta') || normalized.includes('tamil')) return 'உங்களுக்கு எப்படி உதவலாம்?';
  return 'How may I help you?';
}

function cleanSpeechText(value) {
  return String(value ?? '').replace(/\s+([,.!?।])/g, '$1').replace(/\s+/g, ' ').trim();
}

export function welcomeTemplateContext(call) {
  const taskContext = call?.providerMetadata?.context ?? {};
  const preCallContext = call?.providerMetadata?.preCall?.context ?? {};
  const context = { ...taskContext, ...preCallContext };
  if (!context.customer_name && context.lead_name) context.customer_name = context.lead_name;
  return context;
}

export function renderWelcomeTemplate(template, context = {}, options = {}) {
  const source = String(template ?? '').trim();
  if (!source) return {
    text: '', dynamic: false, personalized: false, resolvedVariables: [], missingVariables: [],
  };

  const requested = [...source.matchAll(templatePattern)].map((match) => match[1]);
  if (!requested.length) return {
    text: source, dynamic: false, personalized: false, resolvedVariables: [], missingVariables: [],
  };

  const values = new Map();
  const missing = new Set();
  for (const key of requested) {
    const safeValue = safeTemplateValue(key, readPath(context, key));
    if (safeValue === null) missing.add(key);
    else values.set(key, safeValue);
  }

  let text = source.replace(templatePattern, (match, key) => values.get(key) ?? match);
  if (missing.size) {
    text = text.replace(unresolvedSentencePattern, ' ')
      .replace(templatePattern, ' ');
    text = cleanSpeechText(text);
    const fallback = String(options.fallbackMessage ?? '').trim() || genericHelp(options.language);
    if (fallback) text = cleanSpeechText(`${text} ${fallback}`);
  }

  return {
    text,
    dynamic: true,
    personalized: values.size > 0,
    resolvedVariables: [...values.keys()],
    missingVariables: [...missing],
  };
}
