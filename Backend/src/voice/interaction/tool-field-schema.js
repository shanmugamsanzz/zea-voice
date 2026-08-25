const maximumFields = 30;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function fieldType(schema = {}) {
  const format = String(schema.format ?? '').toLocaleLowerCase().replace(/[_\s]+/gu, '-');
  if (schema['x-catalog-reference'] === true || format === 'catalog-reference') {
    return 'catalog_reference';
  }
  if (Array.isArray(schema.enum) && schema.enum.length) return 'select';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return schema.type;
  if (schema.format === 'date') return 'date';
  if (schema.format === 'time') return 'time';
  if (schema.format === 'email') return 'email';
  if (['phone', 'tel', 'telephone'].includes(String(schema.format ?? '').toLocaleLowerCase())) return 'phone';
  return 'text';
}

function optionAliases(schema, value, index) {
  const aliasConfiguration = object(schema['x-enum-aliases']);
  const configured = aliasConfiguration[String(value)] ?? aliasConfiguration[String(index)] ?? [];
  return [...new Set((Array.isArray(configured) ? configured : [configured])
    .map((entry) => clean(entry, 160)).filter(Boolean))];
}

function fieldOptions(schema = {}) {
  const labels = Array.isArray(schema['x-enum-labels']) ? schema['x-enum-labels'] : [];
  const enumOptions = (Array.isArray(schema.enum) ? schema.enum : []).flatMap((value, index) => {
    const normalized = clean(value, 160);
    const scalar = ['string', 'number', 'boolean'].includes(typeof value);
    return normalized && scalar ? [Object.freeze({
      value,
      label: clean(labels[index], 160) || normalized,
      aliases: Object.freeze(optionAliases(schema, value, index)),
    })] : [];
  });
  const composed = [...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])].flatMap((entry) => {
    const option = object(entry);
    const rawValue = option.const ?? option.value;
    const value = clean(rawValue, 160);
    if (!value || !['string', 'number', 'boolean'].includes(typeof rawValue)) return [];
    const aliases = option.aliases ?? option['x-aliases'] ?? [];
    return [Object.freeze({
      value: rawValue,
      label: clean(option.title ?? option.label, 160) || value,
      aliases: Object.freeze([...new Set((Array.isArray(aliases) ? aliases : [aliases])
        .map((alias) => clean(alias, 160)).filter(Boolean))]),
    })];
  });
  const seen = new Set();
  return Object.freeze([...enumOptions, ...composed].filter((option) => {
    const identity = clean(option.value, 160).toLocaleLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }));
}

function labelFor(key, schema = {}) {
  return clean(schema.title ?? schema.label, 100)
    || clean(key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' '), 100);
}

function questionFor(key, schema = {}) {
  return clean(
    schema.question ?? schema['x-question'] ?? schema['ui:question']
      ?? schema.prompt ?? schema.description,
    500,
  );
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
  )).map(([key, property]) => {
    const normalizedProperty = object(property);
    const options = fieldOptions(normalizedProperty);
    return Object.freeze({
      key,
      label: labelFor(key, normalizedProperty),
      type: fieldType(normalizedProperty),
      required: required.has(key),
      question: questionFor(key, normalizedProperty),
      requiredAction: clean(tool.name, 80).toLocaleLowerCase(),
      ...(options.length ? { options } : {}),
      ...(fieldType(normalizedProperty) === 'catalog_reference' ? {
        catalogReference: Object.freeze({
          namespace: clean(normalizedProperty['x-catalog-namespace'], 80) || 'catalog',
          recordType: clean(normalizedProperty['x-catalog-record-type'], 80) || null,
        }),
      } : {}),
    });
  });
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
