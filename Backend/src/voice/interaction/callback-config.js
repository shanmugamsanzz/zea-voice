export const callbackDefaults = Object.freeze({
  enabled: false,
  minimumDelaySeconds: 30,
  maximumDelayDays: 30,
  closeAfterScheduling: true,
  confirmationInstructions: '',
  clarificationInstructions: '',
  failureInstructions: '',
  followUpOpeningInstructions: '',
});

function boolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw Object.assign(new TypeError('Callback toggle values must be boolean'), { field: 'callback' });
  return value;
}

function integer(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw Object.assign(new TypeError(`${field} must be between ${minimum} and ${maximum}`), { field });
  }
  return number;
}

function instruction(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).normalize('NFC').trim();
  if (normalized.length > 2000) throw Object.assign(new TypeError(`${field} must not exceed 2000 characters`), { field });
  return normalized || fallback;
}

export function resolveCallbackConfiguration(settings = {}) {
  const configuration = {
    enabled: boolean(settings.callbackEnabled, callbackDefaults.enabled),
    minimumDelaySeconds: integer(settings.callbackMinimumDelaySeconds,
      callbackDefaults.minimumDelaySeconds, 30, 86400, 'callbackMinimumDelaySeconds'),
    maximumDelayDays: integer(settings.callbackMaximumDelayDays,
      callbackDefaults.maximumDelayDays, 1, 30, 'callbackMaximumDelayDays'),
    closeAfterScheduling: boolean(settings.callbackCloseAfterScheduling, callbackDefaults.closeAfterScheduling),
    confirmationInstructions: instruction(settings.callbackConfirmationInstructions,
      callbackDefaults.confirmationInstructions, 'callbackConfirmationInstructions'),
    clarificationInstructions: instruction(settings.callbackClarificationInstructions,
      callbackDefaults.clarificationInstructions, 'callbackClarificationInstructions'),
    failureInstructions: instruction(settings.callbackFailureInstructions,
      callbackDefaults.failureInstructions, 'callbackFailureInstructions'),
    followUpOpeningInstructions: instruction(settings.callbackFollowUpOpeningInstructions,
      callbackDefaults.followUpOpeningInstructions, 'callbackFollowUpOpeningInstructions'),
  };
  if (configuration.minimumDelaySeconds * 1000 > configuration.maximumDelayDays * 86400000) {
    throw Object.assign(new TypeError('Minimum callback delay must be lower than the maximum callback delay'), {
      field: 'callbackMinimumDelaySeconds',
    });
  }
  return Object.freeze(configuration);
}

export function normalizeCallbackSettings(settings = {}) {
  const callback = resolveCallbackConfiguration(settings);
  return {
    ...settings,
    callbackEnabled: callback.enabled,
    callbackMinimumDelaySeconds: callback.minimumDelaySeconds,
    callbackMaximumDelayDays: callback.maximumDelayDays,
    callbackCloseAfterScheduling: callback.closeAfterScheduling,
    callbackConfirmationInstructions: callback.confirmationInstructions,
    callbackClarificationInstructions: callback.clarificationInstructions,
    callbackFailureInstructions: callback.failureInstructions,
    callbackFollowUpOpeningInstructions: callback.followUpOpeningInstructions,
  };
}
