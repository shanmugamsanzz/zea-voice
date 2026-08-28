const defaults = Object.freeze({
  highConfidence: 0.86,
  clarificationConfidence: 0.64,
  ambiguityMargin: 0.06,
  clarificationMessage: 'I may not have heard the item correctly. Did you mean {{candidates}}?',
});

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function configurationError(message, field) {
  return Object.assign(new TypeError(message), {
    code: 'KNOWLEDGE_CONFIDENCE_CONFIGURATION_INVALID', field,
  });
}

export function resolveKnowledgeConfidenceConfiguration(settings = {}, { strict = false } = {}) {
  let highConfidence = number(
    settings.highConfidence ?? settings.knowledgeHighConfidence,
    defaults.highConfidence,
  );
  let clarificationConfidence = number(
    settings.clarificationConfidence ?? settings.knowledgeClarificationConfidence,
    defaults.clarificationConfidence,
  );
  let ambiguityMargin = number(
    settings.ambiguityMargin ?? settings.knowledgeAmbiguityMargin,
    defaults.ambiguityMargin,
  );
  const clarificationMessageRaw = String(settings.knowledgeClarificationMessage ?? defaults.clarificationMessage)
    .normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (strict && (highConfidence < 0.7 || highConfidence > 1)) {
    throw configurationError('High Confidence must be between 0.70 and 1.00', 'knowledgeHighConfidence');
  }
  if (strict && (clarificationConfidence < 0.4 || clarificationConfidence >= highConfidence)) {
    throw configurationError('Clarification Confidence must be at least 0.40 and lower than High Confidence', 'knowledgeClarificationConfidence');
  }
  if (strict && (ambiguityMargin < 0.01 || ambiguityMargin > 0.25)) {
    throw configurationError('Ambiguity Margin must be between 0.01 and 0.25', 'knowledgeAmbiguityMargin');
  }
  if (strict && (!clarificationMessageRaw || clarificationMessageRaw.length > 500)) {
    throw configurationError('Clarification Message is required and cannot exceed 500 characters', 'knowledgeClarificationMessage');
  }
  if (!strict) {
    if (highConfidence < 0.7 || highConfidence > 1) highConfidence = defaults.highConfidence;
    if (clarificationConfidence < 0.4 || clarificationConfidence >= highConfidence) {
      clarificationConfidence = Math.min(defaults.clarificationConfidence, highConfidence - 0.01);
    }
    if (ambiguityMargin < 0.01 || ambiguityMargin > 0.25) ambiguityMargin = defaults.ambiguityMargin;
  }
  const clarificationMessage = clarificationMessageRaw.slice(0, 500) || defaults.clarificationMessage;
  return Object.freeze({ highConfidence, clarificationConfidence, ambiguityMargin, clarificationMessage });
}

export function normalizeKnowledgeConfidenceSettings(settings = {}) {
  const configuration = resolveKnowledgeConfidenceConfiguration(settings, { strict: true });
  return {
    ...settings,
    knowledgeHighConfidence: configuration.highConfidence,
    knowledgeClarificationConfidence: configuration.clarificationConfidence,
    knowledgeAmbiguityMargin: configuration.ambiguityMargin,
    knowledgeClarificationMessage: configuration.clarificationMessage,
  };
}

export function renderKnowledgeClarification(template, candidates = []) {
  const names = [...new Set(candidates.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 3);
  return String(template ?? defaults.clarificationMessage)
    .replace(/\{\{\s*candidates\s*\}\}/giu, names.join(', '))
    .trim();
}
