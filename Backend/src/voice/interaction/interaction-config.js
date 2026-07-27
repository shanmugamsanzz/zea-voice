export const greetingModes = Object.freeze({
  AGENT_INITIATES: 'agent_initiates',
  USER_INITIATES: 'user_initiates',
});

export const cachePolicies = Object.freeze({
  PERSISTENT_24H: 'persistent_24h',
  SESSION_ONLY: 'session_only',
  DISABLED: 'disabled',
});

const greetingAliases = new Map([
  ['agent_initiates', greetingModes.AGENT_INITIATES],
  ['agent initiates', greetingModes.AGENT_INITIATES],
  ['agent initiates (standard)', greetingModes.AGENT_INITIATES],
  ['user_initiates', greetingModes.USER_INITIATES],
  ['user initiates', greetingModes.USER_INITIATES],
]);

const cacheAliases = new Map([
  ['persistent_24h', cachePolicies.PERSISTENT_24H],
  ['24h persistent', cachePolicies.PERSISTENT_24H],
  ['24 hour persistent', cachePolicies.PERSISTENT_24H],
  ['24h', cachePolicies.PERSISTENT_24H],
  ['session_only', cachePolicies.SESSION_ONLY],
  ['session only', cachePolicies.SESSION_ONLY],
  ['disabled', cachePolicies.DISABLED],
  ['disable', cachePolicies.DISABLED],
  ['none', cachePolicies.DISABLED],
]);

function alias(value, aliases, fallback, field, strict) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const resolved = aliases.get(String(value).trim().toLowerCase());
  if (resolved) return resolved;
  if (strict) {
    const error = new TypeError(`${field} is not supported`);
    error.code = 'VOICE_INTERACTION_CONFIG_INVALID';
    error.field = field;
    throw error;
  }
  return fallback;
}

export function normalizeContextId(value, { strict = false } = {}) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized || ['optional', 'none', 'null'].includes(normalized.toLowerCase())) return null;
  const valid = normalized.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]*$/.test(normalized);
  if (!valid) {
    if (strict) {
      const error = new TypeError('Context ID must be 1-160 characters and use only letters, numbers, dot, underscore, colon, @, +, / or -');
      error.code = 'VOICE_CONTEXT_ID_INVALID';
      error.field = 'contextId';
      throw error;
    }
    return null;
  }
  return normalized;
}

export function resolveInteractionConfiguration(settings = {}, { strict = false } = {}) {
  return Object.freeze({
    greetingMode: alias(
      settings.greetingMode,
      greetingAliases,
      greetingModes.AGENT_INITIATES,
      'greetingMode',
      strict,
    ),
    cachePolicy: alias(
      settings.cachePolicy,
      cacheAliases,
      cachePolicies.PERSISTENT_24H,
      'cachePolicy',
      strict,
    ),
    contextId: normalizeContextId(settings.contextId, { strict }),
  });
}

export function normalizeInteractionSettings(settings = {}) {
  const interaction = resolveInteractionConfiguration(settings, { strict: true });
  return {
    ...settings,
    greetingMode: interaction.greetingMode,
    cachePolicy: interaction.cachePolicy,
    contextId: interaction.contextId,
  };
}

