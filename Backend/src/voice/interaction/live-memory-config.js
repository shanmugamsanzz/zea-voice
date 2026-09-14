export const conversationContextModes = Object.freeze({
  LAST_N_TURNS: 'last_n_turns',
  FULL_CURRENT_CALL: 'full_current_call',
});

export const memoryFieldTypes = Object.freeze([
  'text', 'number', 'integer', 'date', 'time', 'boolean', 'select', 'email', 'phone',
  'catalog_reference',
]);

const maximumFields = 30;
const maximumRecentTurns = 10;

function configurationError(message, field) {
  const error = new TypeError(message);
  error.code = 'VOICE_LIVE_MEMORY_CONFIG_INVALID';
  error.field = field;
  return error;
}

function cleanText(value, maximum) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizeMode(value, strict) {
  const mode = cleanText(value, 40).toLowerCase() || conversationContextModes.LAST_N_TURNS;
  if (Object.values(conversationContextModes).includes(mode)) return mode;
  if (strict) throw configurationError('Conversation Context Mode is not supported', 'conversationContextMode');
  return conversationContextModes.LAST_N_TURNS;
}

function normalizeField(input, index, strict) {
  const key = cleanText(input?.key, 64);
  const label = cleanText(input?.label, 100);
  const type = cleanText(input?.type, 20).toLowerCase() || 'text';
  const question = cleanText(input?.question, 500);
  const requiredAction = cleanText(input?.requiredAction, 80).toLowerCase();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
    if (strict) throw configurationError('Workflow field keys must use letters, numbers and underscores', `workflowFieldSchemas.${index}.key`);
    return null;
  }
  if (!label) {
    if (strict) throw configurationError('Workflow field label is required', `workflowFieldSchemas.${index}.label`);
    return null;
  }
  if (!memoryFieldTypes.includes(type)) {
    if (strict) throw configurationError('Workflow field type is not supported', `workflowFieldSchemas.${index}.type`);
    return null;
  }
  if (!question) {
    if (strict) throw configurationError('Workflow field question is required', `workflowFieldSchemas.${index}.question`);
    return null;
  }
  if (requiredAction && !/^[a-z][a-z0-9_-]{0,79}$/.test(requiredAction)) {
    if (strict) throw configurationError('Required Action must use lowercase letters, numbers, underscores or hyphens', `workflowFieldSchemas.${index}.requiredAction`);
    return null;
  }
  const options = Object.freeze((Array.isArray(input?.options) ? input.options : []).flatMap((entry) => {
    const option = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry : { value: entry, label: entry };
    const rawValue = option.value;
    const value = cleanText(rawValue, 160);
    if (!value || !['string', 'number', 'boolean'].includes(typeof rawValue)) return [];
    return [Object.freeze({
      value: rawValue,
      label: cleanText(option.label, 160) || value,
      aliases: Object.freeze((Array.isArray(option.aliases) ? option.aliases : [])
        .map((alias) => cleanText(alias, 160)).filter(Boolean)),
    })];
  }));
  return Object.freeze({
    key, label, type, required: input?.required !== false, question,
    ...(requiredAction ? { requiredAction } : {}),
    ...(options.length ? { options } : {}),
    ...(type === 'catalog_reference' && input?.catalogReference
      ? { catalogReference: Object.freeze({ ...input.catalogReference }) } : {}),
  });
}

export function resolveLiveMemoryConfiguration(settings = {}, { strict = false } = {}) {
  const mode = normalizeMode(settings.conversationContextMode, strict);
  const numericTurns = Number(settings.conversationContextTurns ?? 5);
  if ((!Number.isInteger(numericTurns) || numericTurns < 1 || numericTurns > maximumRecentTurns) && strict) {
    throw configurationError(`Recent Turns must be between 1 and ${maximumRecentTurns}`, 'conversationContextTurns');
  }
  const sourceFields = settings.workflowFieldSchemas ?? [];
  if (!Array.isArray(sourceFields)) {
    if (strict) throw configurationError('Workflow field schemas must be a list', 'workflowFieldSchemas');
    return Object.freeze({ mode, recentTurns: 5, fields: Object.freeze([]) });
  }
  if (sourceFields.length > maximumFields && strict) {
    throw configurationError(`Workflow field schemas cannot contain more than ${maximumFields} fields`, 'workflowFieldSchemas');
  }
  const fields = [];
  const seen = new Set();
  for (const [index, input] of sourceFields.slice(0, maximumFields).entries()) {
    const field = normalizeField(input, index, strict);
    if (!field) continue;
    if (seen.has(field.key)) {
      if (strict) throw configurationError('Workflow field keys must be unique', `workflowFieldSchemas.${index}.key`);
      continue;
    }
    seen.add(field.key);
    fields.push(field);
  }
  return Object.freeze({
    mode,
    recentTurns: Number.isInteger(numericTurns) && numericTurns >= 1 && numericTurns <= maximumRecentTurns ? numericTurns : 5,
    fields: Object.freeze(fields),
  });
}

export function normalizeLiveMemorySettings(settings = {}) {
  const configuration = resolveLiveMemoryConfiguration(settings, { strict: true });
  const normalized = {
    ...settings,
    conversationContextMode: configuration.mode,
    conversationContextTurns: configuration.recentTurns,
  };
  delete normalized.contextId;
  delete normalized.conversationMemoryFields;
  delete normalized.workflowFieldSchemas;
  return normalized;
}
