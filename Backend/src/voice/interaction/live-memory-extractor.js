const acknowledgementDefaults = new Set([
  'yes', 'yeah', 'yep', 'no', 'nope', 'ok', 'okay', 'hmm', 'hm', 'sure',
  'ஆம்', 'ஆமா', 'இல்லை', 'இல்ல', 'சரி', 'ம்', 'ஹம்',
]);

// Generic spoken date/time forms. These are language-level parsing patterns,
// not tenant or industry rules. They retain the caller's spoken value; date
// resolution remains the responsibility of the configured booking operation.
const monthNames = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ஜனவரி|பிப்ரவரி|மார்ச்|ஏப்ரல்|மே|ஜூன்|ஜூலை|ஆகஸ்ட்|செப்டம்பர்|அக்டோபர்|நவம்பர்|டிசம்பர்)';
const dateValuePattern = new RegExp(`\\b(?:today|tomorrow|day after tomorrow)\\b|இன்று|நாளை|நாளைக்கு|மறுநாள்|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${monthNames}(?:\\s*,?\\s*\\d{2,4})?|${monthNames}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{2,4})?`, 'iu');
const timeValuePattern = /\b(?:morning|afternoon|evening|night)\s*\d{1,2}(?::\d{2})?\b|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|o\s*'?clock|in the morning|in the evening)\b|காலை\s*\d{1,2}|மாலை\s*\d{1,2}|இரவு\s*\d{1,2}|\d{1,2}\s*மணிக்கு?|\b(?:kalai|maalai|malai|iravu)\s*\d{1,2}(?:\s*mani)?\b|\d{1,2}\s*mani\b/iu;

function normalized(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

function regexp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAcknowledgementOnly(text, acknowledgementPhrases = []) {
  const value = normalized(text).toLocaleLowerCase();
  const configured = new Set(acknowledgementPhrases.map((entry) => normalized(entry).toLocaleLowerCase()));
  return acknowledgementDefaults.has(value) || configured.has(value);
}

function looksLikeQuestion(text) {
  const value = normalized(text).toLocaleLowerCase();
  if (!value) return false;
  if (/[?？]\s*$/u.test(value)) return true;
  return /\b(?:who|what|when|where|why|how|which|can|could|would|do|does|did|is|are)\b/iu.test(value)
    || /(?:என்ன|எங்கே|எங்க|எப்ப|எப்படி|ஏன்|எது|எந்த|யாரு|யார்|முடியுமா|இருக்கா|இருக்கீங்களா)/u.test(value);
}

function fieldAliases(field) {
  const label = normalized(field.label);
  const words = label.split(/\s+/gu).filter((word) => Array.from(word).length >= 3);
  return [...new Set([field.key, field.key.replace(/_/gu, ' '), label, words.at(-1)])]
    .map(normalized).filter(Boolean).sort((left, right) => right.length - left.length);
}

function explicitFieldValue(field, text, fields) {
  const aliases = fieldAliases(field);
  const everyAlias = [...new Set(fields.flatMap(fieldAliases))].sort((left, right) => right.length - left.length);
  const nextField = everyAlias.length ? `(?=\\s+(?:${everyAlias.map(regexp).join('|')})\\s*(?:is|:|=|ன்னா|என்பது|வந்து)?|[,;.!?]|$)` : '(?=[,;.!?]|$)';
  const match = text.match(new RegExp(`(?:${aliases.map(regexp).join('|')})\\s*(?:is|:|=|ன்னா|என்பது|வந்து)?\\s*(.+?)${nextField}`, 'iu'));
  return normalized(match?.[1] ?? '');
}

function typedValue(field, text, pending, fields) {
  const explicit = explicitFieldValue(field, text, fields);
  const candidate = explicit || (pending ? text : '');
  if (!candidate) return '';
  if (field.type === 'email') return candidate.match(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u)?.[0] ?? '';
  if (field.type === 'phone') return candidate.match(/(?:\+?\d[\d\s()-]{7,}\d)/u)?.[0]?.replace(/[\s()-]/gu, '') ?? '';
  if (field.type === 'number') return candidate.match(/-?\d+(?:\.\d+)?/u)?.[0] ?? (pending ? candidate : '');
  if (field.type === 'date') {
    return candidate.match(dateValuePattern)?.[0] ?? (explicit ? explicit : '');
  }
  if (field.type === 'time') {
    return candidate.match(timeValuePattern)?.[0] ?? (explicit ? explicit : '');
  }
  if (field.type === 'boolean') {
    if (/^(?:yes|yeah|yep|true|ஆம்|ஆமா|சரி)$/iu.test(candidate)) return true;
    if (/^(?:no|nope|false|இல்லை|இல்ல|வேண்டாம்)$/iu.test(candidate)) return false;
    return '';
  }
  return candidate.slice(0, 500);
}

export function captureConfiguredMemoryFields({ fields = [], collectedData = {}, pendingQuestion, text, acknowledgementPhrases = [] }) {
  const utterance = normalized(text);
  if (!utterance || isAcknowledgementOnly(utterance, acknowledgementPhrases)) return Object.freeze({});
  const updates = {};
  for (const field of fields) {
    const pending = pendingQuestion === field.key;
    const explicit = explicitFieldValue(field, utterance, fields);
    if (collectedData[field.key] !== undefined && !explicit) continue;
    // A caller can ask a side question while a free-text field is pending.
    // Never store that question as the field value; routing will answer it and
    // the conversation frame will resume the original configured question.
    if (pending && !explicit && looksLikeQuestion(utterance)) continue;
    // Dates and times are self-identifying values. Capture them in the same
    // finalized booking-field turn even when another booking field was the
    // pending question, so callers can provide date and time together.
    const value = typedValue(field, utterance, pending || field.type === 'date' || field.type === 'time', fields);
    if (value !== '' && value !== undefined && value !== null) updates[field.key] = value;
  }
  return Object.freeze(updates);
}

export function pendingFieldFromAssistantResponse(fields = [], response = '') {
  const answer = normalized(response).toLocaleLowerCase();
  if (!answer) return null;
  for (const field of fields) {
    const question = normalized(field.question).toLocaleLowerCase();
    if (question && answer.includes(question)) return field.key;
  }
  return null;
}
