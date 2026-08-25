const numericDatePattern = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/u;
const numericTimePattern = /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)(?:\s*[ap]m)?\b|\b(?:1[0-2]|0?[1-9])\s*[ap]m\b/iu;
const emailPattern = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;
const phonePattern = /\+?[\d][\d\s()-]{6,23}[\d]/u;
const numberPattern = /[-+]?\d+(?:[.,]\d+)?/u;

function clean(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function containsForm(utterance, form) {
  const source = ` ${identity(utterance)} `;
  const candidate = identity(form);
  return Boolean(candidate) && source.includes(` ${candidate} `);
}

function optionForms(option = {}) {
  const aliases = Array.isArray(option.aliases) ? option.aliases : [];
  return [option.value ?? option.const, option.label ?? option.title, ...aliases]
    .map((entry) => clean(entry, 160)).filter(Boolean);
}

function enumValue(schema, transcript) {
  const matches = (schema.options ?? []).flatMap((option) => {
    const length = Math.max(0, ...optionForms(option)
      .filter((form) => containsForm(transcript, form)).map((form) => identity(form).length));
    return length ? [{ value: option.value ?? option.const, length }] : [];
  }).sort((left, right) => right.length - left.length);
  return matches[0]?.value;
}

function catalogValue(schema, transcript, entities = []) {
  const requiredType = clean(schema.catalogReference?.recordType, 80).toLocaleLowerCase();
  const candidates = (Array.isArray(entities) ? entities : []).filter((entity) => {
    const recordType = clean(entity?.recordType ?? entity?.type, 80).toLocaleLowerCase();
    return entity && (!requiredType || recordType === requiredType);
  });
  const matches = candidates.filter((entity) => {
    const forms = [entity.name, entity.key, ...(Array.isArray(entity.aliases) ? entity.aliases : [])];
    const explicit = forms.some((form) => containsForm(transcript, form));
    const highConfidence = String(entity.confidenceLevel ?? '').toLocaleUpperCase() === 'HIGH'
      || Number(entity.confidence ?? entity.score ?? 0) >= 0.85;
    return explicit || (candidates.length === 1 && highConfidence);
  });
  if (matches.length !== 1) return undefined;
  return clean(matches[0].name ?? matches[0].key ?? matches[0].recordId, 240) || undefined;
}

function labeledValue(schema, transcript) {
  const aliases = Array.isArray(schema.aliases) ? schema.aliases : [];
  for (const label of [schema.label, ...aliases].map((entry) => clean(entry, 100)).filter(Boolean)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = String(transcript).match(new RegExp(`${escaped}\\s*(?::|=)\\s*([^,;]+)`, 'iu'));
    if (match?.[1]) return clean(match[1]);
  }
  return undefined;
}

function currentQuestion(history = []) {
  return [...history].reverse().find((entry) => entry?.role === 'assistant')?.content ?? '';
}

function questionTargets(schema, history) {
  const question = identity(currentQuestion(history));
  return Boolean(question) && [schema.question, schema.label]
    .map(identity).filter(Boolean).some((candidate) => question === candidate || question.includes(candidate));
}

export function extractSchemaFieldValue(schema = {}, transcript, {
  history = [], resolvedEntities = [], onlyMissing = false,
} = {}) {
  const text = clean(transcript);
  if (!text) return undefined;
  const type = clean(schema.type, 40).toLocaleLowerCase();
  if (type === 'select') return enumValue(schema, text);
  if (type === 'catalog_reference') return catalogValue(schema, text, resolvedEntities);
  const explicit = labeledValue(schema, text);
  const candidate = explicit ?? (onlyMissing && questionTargets(schema, history) ? text : undefined);
  if (type === 'number' || type === 'integer') {
    const match = (explicit ?? text).match(numberPattern)?.[0]?.replace(',', '.');
    if (!match) return undefined;
    const numeric = Number(match);
    return Number.isFinite(numeric) && (type !== 'integer' || Number.isInteger(numeric))
      ? numeric : undefined;
  }
  if (type === 'date') return (explicit ?? text).match(numericDatePattern)?.[0];
  if (type === 'time') return (explicit ?? text).match(numericTimePattern)?.[0];
  if (type === 'email') return (explicit ?? text).match(emailPattern)?.[0];
  if (type === 'phone') return clean((explicit ?? text).match(phonePattern)?.[0]);
  if (type === 'boolean') return undefined;
  return candidate;
}
