const maximumFields = 30;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function fieldType(schema = {}) {
  if (Array.isArray(schema.enum) && schema.enum.length) return 'select';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.format === 'date') return 'date';
  if (schema.format === 'time') return 'time';
  if (schema.format === 'email') return 'email';
  if (['phone', 'tel', 'telephone'].includes(String(schema.format ?? '').toLocaleLowerCase())) return 'phone';
  return 'text';
}

function labelFor(key, schema = {}) {
  return clean(schema.title ?? schema.label, 100)
    || clean(key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' '), 100);
}

function questionFor(key, schema = {}) {
  const label = labelFor(key, schema);
  return clean(
    schema.question ?? schema['x-question'] ?? schema['ui:question']
      ?? schema.prompt ?? schema.description,
    500,
  ) || `Please provide ${label}.`;
}

function validFieldKey(value) {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value);
}

function toolFields(tool = {}) {
  const schema = object(tool.inputSchema ?? tool.configuration?.inputSchema
    ?? tool.configuration?.input_schema);
  const properties = object(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).filter(([key, property]) => (
    validFieldKey(key) && !['array', 'object'].includes(object(property).type)
  )).map(([key, property]) => Object.freeze({
    key,
    label: labelFor(key, property),
    type: fieldType(property),
    required: required.has(key),
    question: questionFor(key, property),
    requiredAction: clean(tool.name, 80).toLocaleLowerCase(),
  }));
}

export function mergeToolFieldSchemas(configuredFields = [], tools = []) {
  const explicit = new Map((Array.isArray(configuredFields) ? configuredFields : [])
    .filter((field) => validFieldKey(clean(field?.key, 64)))
    .map((field) => [clean(field.key, 64), { ...field }]));
  const owners = new Map();
  const generated = [];
  for (const tool of tools ?? []) {
    for (const field of toolFields(tool)) {
      owners.set(field.key, (owners.get(field.key) ?? 0) + 1);
      generated.push(field);
    }
  }
  const merged = [];
  const seen = new Set();
  for (const field of generated) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    const override = explicit.get(field.key);
    merged.push({
      ...field,
      ...override,
      key: field.key,
      required: field.required || override?.required === true,
      ...(owners.get(field.key) === 1
        ? { requiredAction: override?.requiredAction ?? field.requiredAction }
        : (override?.requiredAction ? { requiredAction: override.requiredAction } : {})),
    });
  }
  for (const [key, field] of explicit) {
    if (seen.has(key)) continue;
    merged.push(field);
  }
  return Object.freeze(merged.slice(0, maximumFields).map((field) => Object.freeze({ ...field })));
}

