const maxRequiredFields = 20;
const maxFieldLength = 64;
const maxIntentLength = 80;
const maxConfirmationLength = 2_000;
const fieldPattern = /^[a-z][a-z0-9_]{0,63}$/;
const intentPattern = /^[a-z][a-z0-9_-]{0,79}$/;

function configurationError(message, field = 'taskCompletion') {
  return Object.assign(new TypeError(message), {
    code: 'TASK_COMPLETION_CONFIGURATION_INVALID', field,
  });
}

function text(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/**
 * Stores only the developer's completion policy. Runtime data collection and
 * automatic call closing are deliberately handled in the later runtime task.
 */
export function resolveTaskCompletionConfiguration(settings = {}, { strict = false } = {}) {
  const enabled = settings.taskCompletionEnabled === true;
  const intent = text(settings.taskCompletionIntent);
  const confirmationMessage = text(settings.taskCompletionConfirmationMessage);
  const requiresCatalogItem = settings.taskCompletionRequiresCatalogItem === true;
  const catalogField = text(settings.taskCompletionCatalogField).toLowerCase();
  const inputFields = settings.taskCompletionRequiredFields ?? [];

  if (!Array.isArray(inputFields)) {
    if (strict) throw configurationError('Required Information must be a list of field identifiers', 'taskCompletionRequiredFields');
    return Object.freeze({ enabled: false, intent: '', requiredFields: Object.freeze([]), confirmationMessage: '' });
  }
  if (inputFields.length > maxRequiredFields) {
    throw configurationError(`Required Information cannot contain more than ${maxRequiredFields} fields`, 'taskCompletionRequiredFields');
  }

  const requiredFields = [];
  const seen = new Set();
  for (const value of inputFields) {
    const field = text(value).toLowerCase();
    if (!field) continue;
    if (field.length > maxFieldLength || !fieldPattern.test(field)) {
      throw configurationError('Each required field must use lowercase letters, numbers and underscores only', 'taskCompletionRequiredFields');
    }
    if (!seen.has(field)) {
      seen.add(field);
      requiredFields.push(field);
    }
  }

  if (intent && !intentPattern.test(intent)) {
    throw configurationError('Completion Intent must use lowercase letters, numbers, hyphens or underscores only', 'taskCompletionIntent');
  }
  if (catalogField && !fieldPattern.test(catalogField)) {
    throw configurationError('Catalog Field must use lowercase letters, numbers and underscores only', 'taskCompletionCatalogField');
  }
  if (confirmationMessage.length > maxConfirmationLength) {
    throw configurationError(`Confirmation Message cannot exceed ${maxConfirmationLength.toLocaleString('en-US')} characters`, 'taskCompletionConfirmationMessage');
  }
  if (enabled) {
    if (!intent) throw configurationError('Completion Intent is required when automatic task completion is enabled', 'taskCompletionIntent');
    if (!requiredFields.length) throw configurationError('Add at least one Required Information field when automatic task completion is enabled', 'taskCompletionRequiredFields');
    if (!confirmationMessage) throw configurationError('Confirmation Message is required when automatic task completion is enabled', 'taskCompletionConfirmationMessage');
    if (requiresCatalogItem && (!catalogField || !requiredFields.includes(catalogField))) {
      throw configurationError('Catalog Field must be one of Required Information when Catalog selection is required', 'taskCompletionCatalogField');
    }
  }

  return Object.freeze({
    enabled,
    intent,
    requiredFields: Object.freeze(requiredFields),
    confirmationMessage,
    requiresCatalogItem,
    catalogField,
  });
}

export function normalizeTaskCompletionSettings(settings = {}) {
  const configuration = resolveTaskCompletionConfiguration(settings, { strict: true });
  return {
    ...settings,
    taskCompletionEnabled: configuration.enabled,
    taskCompletionIntent: configuration.intent,
    taskCompletionRequiredFields: [...configuration.requiredFields],
    taskCompletionConfirmationMessage: configuration.confirmationMessage,
    taskCompletionRequiresCatalogItem: configuration.requiresCatalogItem,
    taskCompletionCatalogField: configuration.catalogField,
  };
}
