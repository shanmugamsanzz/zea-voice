export const conversationContextModes = Object.freeze({
  LAST_N_TURNS: 'last_n_turns',
  FULL_CURRENT_CALL: 'full_current_call',
});

export const memoryFieldTypes = Object.freeze([
  'text', 'number', 'date', 'time', 'boolean', 'select', 'email', 'phone',
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
    if (strict) throw configurationError('Information field keys must use letters, numbers and underscores', `conversationMemoryFields.${index}.key`);
    return null;
  }
  if (!label) {
    if (strict) throw configurationError('Information field label is required', `conversationMemoryFields.${index}.label`);
    return null;
  }
  if (!memoryFieldTypes.includes(type)) {
    if (strict) throw configurationError('Information field type is not supported', `conversationMemoryFields.${index}.type`);
    return null;
  }
  if (!question) {
    if (strict) throw configurationError('Information field question is required', `conversationMemoryFields.${index}.question`);
    return null;
  }
  if (requiredAction && !/^[a-z][a-z0-9_-]{0,79}$/.test(requiredAction)) {
    if (strict) throw configurationError('Required Action must use lowercase letters, numbers, underscores or hyphens', `conversationMemoryFields.${index}.requiredAction`);
    return null;
  }
  return Object.freeze({
    key, label, type, required: input?.required !== false, question,
    ...(requiredAction ? { requiredAction } : {}),
  });
}

export function resolveLiveMemoryConfiguration(settings = {}, { strict = false } = {}) {
  const mode = normalizeMode(settings.conversationContextMode, strict);
  const numericTurns = Number(settings.conversationContextTurns ?? 5);
  if ((!Number.isInteger(numericTurns) || numericTurns < 1 || numericTurns > maximumRecentTurns) && strict) {
    throw configurationError(`Recent Turns must be between 1 and ${maximumRecentTurns}`, 'conversationContextTurns');
  }
  const sourceFields = settings.conversationMemoryFields ?? [];
  if (!Array.isArray(sourceFields)) {
    if (strict) throw configurationError('Important Information Fields must be a list', 'conversationMemoryFields');
    return Object.freeze({ mode, recentTurns: 5, fields: Object.freeze([]) });
  }
  if (sourceFields.length > maximumFields && strict) {
    throw configurationError(`Important Information Fields cannot contain more than ${maximumFields} fields`, 'conversationMemoryFields');
  }
  const fields = [];
  const seen = new Set();
  for (const [index, input] of sourceFields.slice(0, maximumFields).entries()) {
    const field = normalizeField(input, index, strict);
    if (!field) continue;
    if (seen.has(field.key)) {
      if (strict) throw configurationError('Information field keys must be unique', `conversationMemoryFields.${index}.key`);
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
  return {
    ...settings,
    conversationContextMode: configuration.mode,
    conversationContextTurns: configuration.recentTurns,
    conversationMemoryFields: configuration.fields.map((field) => ({ ...field })),
  };
}
