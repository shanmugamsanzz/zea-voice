const messageTypes = Object.freeze({ dynamic: 'Dynamic', static: 'Static', none: 'None' });
const defaultDynamicPrompt = 'Generate one brief, natural closing sentence based on the completed conversation and closing reason.';

function configurationError(message, field) {
  return Object.assign(new TypeError(message), {
    code: 'POSTCALL_CLOSING_CONFIGURATION_INVALID', field,
  });
}

function canonicalType(value) {
  const normalized = String(value ?? 'Dynamic').trim().toLowerCase();
  if (!messageTypes[normalized]) {
    throw configurationError('Post-Call Message Type must be Dynamic, Static, or None', 'postCallMessageType');
  }
  return messageTypes[normalized];
}

export function resolvePostCallClosingConfiguration(settings = {}, options = {}) {
  const strict = options.strict === true;
  const messageType = canonicalType(settings.postCallMessageType ?? settings.messageType);
  const rawPrompt = settings.postCallPrompt ?? settings.prompt;
  const prompt = String(rawPrompt === undefined ? defaultDynamicPrompt : rawPrompt).trim();
  const staticMessage = String(settings.postCallStaticMessage ?? settings.staticMessage ?? '').trim();
  if (strict && messageType === 'Dynamic' && !prompt) {
    throw configurationError('Dynamic Closing Prompt is required for Dynamic message type', 'postCallPrompt');
  }
  if (strict && messageType === 'Static' && !staticMessage) {
    throw configurationError('Static Closing Message is required for Static message type', 'postCallStaticMessage');
  }
  if (prompt.length > 20_000) {
    throw configurationError('Dynamic Closing Prompt cannot exceed 20,000 characters', 'postCallPrompt');
  }
  if (staticMessage.length > 10_000) {
    throw configurationError('Static Closing Message cannot exceed 10,000 characters', 'postCallStaticMessage');
  }
  return Object.freeze({ messageType, prompt, staticMessage });
}

export function normalizePostCallClosingSettings(settings = {}) {
  const configuration = resolvePostCallClosingConfiguration(settings, { strict: true });
  return {
    ...settings,
    postCallMessageType: configuration.messageType,
    postCallPrompt: configuration.prompt,
    postCallStaticMessage: configuration.staticMessage,
  };
}
