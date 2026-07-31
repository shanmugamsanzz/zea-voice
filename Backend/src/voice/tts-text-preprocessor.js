const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*}}|\$\{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*}/g;
const MAX_TEMPLATE_VALUE_CHARACTERS = 240;

function localeFor(language) {
  const value = String(language ?? '').trim();
  if (/^ta(?:-|$)|tamil/i.test(value)) return 'ta-IN';
  if (/^hi(?:-|$)|hindi/i.test(value)) return 'hi-IN';
  if (/^te(?:-|$)|telugu/i.test(value)) return 'te-IN';
  if (/^kn(?:-|$)|kannada/i.test(value)) return 'kn-IN';
  if (/^ml(?:-|$)|malayalam/i.test(value)) return 'ml-IN';
  const code = value.match(/^([A-Za-z]{2,3})(?:[-_][A-Za-z]{2})?$/)?.[1]?.toLowerCase();
  return code === 'en' ? 'en-US' : (code ? `${code}-IN` : 'en-US');
}

function safeTimeZone(value) {
  const candidate = String(value ?? '').trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'UTC';
  }
}

function readPath(value, path) {
  return String(path).split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function safeValue(value) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  const normalized = String(value).normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/{{|}}|\$\{|}/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, MAX_TEMPLATE_VALUE_CHARACTERS).join('');
}

function formatDate(value, locale, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone,
  }).format(date);
}

function formatTime(value, locale, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone,
  }).format(date);
}

function builtIns(now, locale, timeZone) {
  return {
    currentDate: formatDate(now, locale, timeZone),
    current_date: formatDate(now, locale, timeZone),
    today: formatDate(now, locale, timeZone),
    currentTime: formatTime(now, locale, timeZone),
    current_time: formatTime(now, locale, timeZone),
  };
}

function replaceIsoDates(text, locale, timeZone) {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (match, value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day, 12));
    return formatDate(parsed, locale, timeZone) ?? match;
  });
}

function normalizeSpeakableText(value, locale, timeZone) {
  const tamil = locale.toLowerCase().startsWith('ta');
  let text = String(value ?? '').normalize('NFC');
  text = text
    .replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/gi, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#]+/g, ' ');
  text = replaceIsoDates(text, locale, timeZone)
    .replace(/₹\s*([\d,]+(?:\.\d+)?)/g, (_, amount) => `${amount.replace(/,/g, '')} ${tamil ? 'ரூபாய்' : 'rupees'}`)
    .replace(/(\d+(?:\.\d+)?)\s*%/g, (_, amount) => `${amount} ${tamil ? 'சதவீதம்' : 'percent'}`)
    .replace(/\s*&\s*/g, tamil ? ' மற்றும் ' : ' and ')
    .replace(/[\[\]{}<>|~^]+/g, ' ')
    .replace(/([!?.,])\1{1,}/g, '$1')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export class TtsTextPreprocessor {
  constructor(options = {}) {
    this.locale = localeFor(options.language);
    this.timeZone = safeTimeZone(options.timeZone);
    this.context = options.context && typeof options.context === 'object' ? options.context : {};
    this.now = options.now ?? (() => new Date());
  }

  process(value, runtimeContext = {}) {
    const source = String(value ?? '').normalize('NFC').trim();
    if (!source) return {
      text: '', changed: false, resolvedVariables: [], unresolvedVariables: [],
    };
    const context = {
      ...this.context,
      ...(runtimeContext && typeof runtimeContext === 'object' ? runtimeContext : {}),
    };
    let builtinContext;
    const resolvedVariables = new Set();
    const unresolvedVariables = new Set();
    const rendered = source.replace(PLACEHOLDER_PATTERN, (_match, moustacheKey, dollarKey) => {
      const key = moustacheKey ?? dollarKey;
      let value = readPath(context, key);
      if (value === undefined && ['currentDate', 'current_date', 'today', 'currentTime', 'current_time'].includes(key)) {
        const nowValue = this.now();
        const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
        const cacheKey = Number.isNaN(now.getTime()) ? 'invalid' : Math.floor(now.getTime() / 60_000);
        if (this.builtinCache?.key !== cacheKey) {
          this.builtinCache = { key: cacheKey, values: builtIns(now, this.locale, this.timeZone) };
        }
        builtinContext ??= this.builtinCache.values;
        value = builtinContext[key];
      }
      const resolved = safeValue(value);
      if (resolved === null) {
        unresolvedVariables.add(key);
        return ' ';
      }
      resolvedVariables.add(key);
      return resolved;
    });
    const text = normalizeSpeakableText(rendered, this.locale, this.timeZone);
    return {
      text,
      changed: text !== source,
      resolvedVariables: [...resolvedVariables],
      unresolvedVariables: [...unresolvedVariables],
    };
  }
}

export function createTtsTextPreprocessor(options = {}) {
  return new TtsTextPreprocessor(options);
}
