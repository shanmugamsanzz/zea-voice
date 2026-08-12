import { resolveTaskCompletionConfiguration } from './completion-config.js';

const templatePattern = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/giu;
const ignoredAnswerPattern = /^(?:yes|yeah|yep|no|nope|ok|okay|hmm|hm|ஆமா|ஆம்|இல்லை|இல்ல|சரி|ம்)$/iu;
const monthNames = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ஜனவரி|பிப்ரவரி|மார்ச்|ஏப்ரல்|மே|ஜூன்|ஜூலை|ஆகஸ்ட்|செப்டம்பர்|அக்டோபர்|நவம்பர்|டிசம்பர்)';
const dateValuePattern = new RegExp(`\\b(?:today|tomorrow|day after tomorrow)\\b|இன்று|நாளை|நாளைக்கு|மறுநாள்|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${monthNames}(?:\\s*,?\\s*\\d{2,4})?|${monthNames}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{2,4})?`, 'iu');
const timeValuePattern = /\b(?:morning|afternoon|evening|night)\s*\d{1,2}(?::\d{2})?\b|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|o\s*'?clock|in the morning|in the evening)\b|காலை\s*\d{1,2}|மாலை\s*\d{1,2}|இரவு\s*\d{1,2}|\d{1,2}\s*மணிக்கு?|\b(?:kalai|maalai|malai|iravu)\s*\d{1,2}(?:\s*mani)?\b|\d{1,2}\s*mani\b/iu;

function compact(value, maximum = 160) {
  const text = String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, maximum).join('');
}

function assistantQuestion(history = []) {
  return [...history].reverse().find((entry) => entry?.role === 'assistant')?.content ?? '';
}

function questionMentions(question, type) {
  const text = String(question).toLocaleLowerCase();
  const patterns = {
    name: /\bname\b|பெயர்|பேரு|யாருக்காக/u,
    age: /\bage\b|வயசு|வயது/u,
    package: /\bpackage\b|பேக்கேஜ்|பாக்கேஜ்/u,
    date: /\bdate\b|தேதி|நாளை|எந்த நாள்/u,
    time: /\btime\b|\bclock\b|மணி|எத்தனை நேரம்/u,
  };
  return patterns[type]?.test(text) ?? false;
}

function fieldType(field) {
  if (field.includes('name')) return 'name';
  if (field.includes('package')) return 'package';
  if (field.includes('age')) return 'age';
  if (field.includes('date')) return 'date';
  if (field.includes('time')) return 'time';
  return 'custom';
}

function labeledValue(text, labels) {
  const label = labels.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(text).match(new RegExp(`(?:${label})\\s*(?:is|:|=|ன்னா|என்னா)?\\s*([^,.!?]+)`, 'iu'));
  return compact(match?.[1] ?? '');
}

function removeFollowingField(text, words) {
  const result = String(text);
  for (const word of words) {
    const index = result.toLocaleLowerCase().indexOf(word.toLocaleLowerCase());
    if (index >= 0) return compact(result.slice(0, index));
  }
  return compact(result);
}

function detectValue(field, transcript, history) {
  const text = compact(transcript);
  if (!text || ignoredAnswerPattern.test(text)) return '';
  const type = fieldType(field);
  const asked = assistantQuestion(history);
  if (type === 'package') {
    return text.match(/\b(silver|gold|platinum)\b/iu)?.[1]?.replace(/^./u, (letter) => letter.toUpperCase())
      ?? (questionMentions(asked, 'package') ? text : '');
  }
  if (type === 'age') {
    const explicit = labeledValue(text, ['age', 'வயசு', 'வயது']);
    if (explicit) return explicit;
    if (questionMentions(asked, 'age') && (/[0-9]/u.test(text) || /one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|நொன்று|இருப/u.test(text))) return text;
    return '';
  }
  if (type === 'date') {
    const explicit = labeledValue(text, ['date', 'தேதி']);
    if (explicit) return explicit;
    const detectedDate = text.match(dateValuePattern)?.[0];
    if (detectedDate) return detectedDate;
    return '';
  }
  if (type === 'time') {
    const explicit = labeledValue(text, ['time', 'clock', 'மணி', 'நேரம்']);
    if (explicit) return explicit;
    const detectedTime = text.match(timeValuePattern)?.[0];
    if (detectedTime) return detectedTime;
    return '';
  }
  if (type === 'name') {
    const explicit = labeledValue(text, ['name', 'பெயர்', 'பேரு']);
    if (explicit) return removeFollowingField(explicit, ['age', 'வயசு', 'வயது']);
    if (questionMentions(asked, 'name')) return removeFollowingField(text, ['age', 'வயசு', 'வயது']);
    return '';
  }
  const humanField = field.replace(/_/g, ' ');
  const explicit = labeledValue(text, [field, humanField]);
  if (explicit) return explicit;
  return String(asked).toLocaleLowerCase().includes(humanField) ? text : '';
}

function safeContextValue(value) {
  const result = compact(value);
  return result && !ignoredAnswerPattern.test(result) ? result : '';
}

export function createTaskCompletionState(settings = {}, context = {}) {
  const configuration = resolveTaskCompletionConfiguration(settings);
  const values = {};
  for (const field of configuration.requiredFields) {
    const value = safeContextValue(context[field]);
    if (value) values[field] = value;
  }
  return { configuration, values };
}

export function captureTaskCompletionInput(state, transcript, history = []) {
  const configuration = state?.configuration ?? resolveTaskCompletionConfiguration({});
  const values = { ...(state?.values ?? {}) };
  const captured = [];
  if (!configuration.enabled) return { state: { configuration, values }, captured, missing: [], complete: false };
  for (const field of configuration.requiredFields) {
    if (values[field]) continue;
    const value = detectValue(field, transcript, history);
    if (!value) continue;
    values[field] = value;
    captured.push(field);
  }
  const missing = configuration.requiredFields.filter((field) => !values[field]);
  return {
    state: { configuration, values },
    captured,
    missing,
    complete: missing.length === 0,
  };
}

export function mergeTaskCompletionData(state, updates = {}) {
  const configuration = state?.configuration ?? resolveTaskCompletionConfiguration({});
  const values = { ...(state?.values ?? {}) };
  for (const field of configuration.requiredFields) {
    const value = safeContextValue(updates[field]);
    if (value) values[field] = value;
  }
  return { configuration, values };
}

export function renderTaskCompletionConfirmation(state) {
  const template = String(state?.configuration?.confirmationMessage ?? '').trim();
  if (!template) return '';
  return compact(template.replace(templatePattern, (match, field) => compact(state?.values?.[field]) || ''));
}

export function publicTaskCompletionState(state) {
  const configuration = state?.configuration ?? resolveTaskCompletionConfiguration({});
  const values = { ...(state?.values ?? {}) };
  return Object.freeze({
    enabled: configuration.enabled,
    intent: configuration.intent || null,
    requiredFields: [...configuration.requiredFields],
    collectedData: values,
    missingFields: configuration.requiredFields.filter((field) => !values[field]),
    completed: configuration.enabled && configuration.requiredFields.every((field) => Boolean(values[field])),
    requiresCatalogItem: configuration.requiresCatalogItem === true,
    catalogField: configuration.catalogField || null,
  });
}
