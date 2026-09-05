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
  return configured.has(value);
}

function looksLikeQuestion(text) {
  const value = normalized(text).toLocaleLowerCase();
  if (!value) return false;
  return /[?？]\s*$/u.test(value);
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
  const nextField = everyAlias.length ? `(?=\\s+(?:${everyAlias.map(regexp).join('|')})\\s*[:=]?|[,;.!?]|$)` : '(?=[,;.!?]|$)';
  const match = text.match(new RegExp(`(?:${aliases.map(regexp).join('|')})\\s*[:=]?\\s*(.+?)${nextField}`, 'iu'));
  return normalized(match?.[1] ?? '');
}

function typedValue(field, text, pending, fields) {
  const explicit = explicitFieldValue(field, text, fields);
  const candidate = explicit || (pending ? text : '');
  if (!candidate) return '';
  if (field.type === 'email') return candidate.match(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u)?.[0] ?? '';
  if (field.type === 'phone') return candidate.match(/(?:\+?\d[\d\s()-]{7,}\d)/u)?.[0]?.replace(/[\s()-]/gu, '') ?? '';
  if (field.type === 'number') return candidate.match(/-?\d+(?:\.\d+)?/u)?.[0] ?? (pending ? candidate : '');
  if (['date', 'time', 'boolean'].includes(field.type)) return candidate;
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
    const value = typedValue(field, utterance, pending, fields);
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
