const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxInstructionsCharacters = 20_000;

function configurationError(message, field) {
  return Object.assign(new TypeError(message), {
    code: 'POSTCALL_SUMMARY_CONFIGURATION_INVALID',
    field,
  });
}

export function resolvePostCallSummaryConfiguration(settings = {}, options = {}) {
  const strict = options.strict === true;
  const enabled = settings.postCallSummaryEnabled === true;
  const modelId = String(settings.postCallSummaryModelId ?? '').trim();
  const instructions = String(settings.postCallSummaryInstructions ?? '').trim();

  if (strict && enabled && !uuidPattern.test(modelId)) {
    throw configurationError(
      'Select an active LLM model for Post-Call AI Summary',
      'postCallSummaryModelId',
    );
  }
  if (strict && enabled && !instructions) {
    throw configurationError(
      'Post-Call Summary Instructions are required when AI Summary is enabled',
      'postCallSummaryInstructions',
    );
  }
  if (instructions.length > maxInstructionsCharacters) {
    throw configurationError(
      `Post-Call Summary Instructions cannot exceed ${maxInstructionsCharacters.toLocaleString('en-US')} characters`,
      'postCallSummaryInstructions',
    );
  }

  return Object.freeze({
    enabled,
    modelId,
    instructions,
    includeTranscript: settings.postCallIncludeTranscript !== false,
    includeSummary: settings.postCallIncludeSummary !== false,
  });
}

export function normalizePostCallSummarySettings(settings = {}) {
  const configuration = resolvePostCallSummaryConfiguration(settings, { strict: true });
  return {
    ...settings,
    postCallSummaryEnabled: configuration.enabled,
    postCallSummaryModelId: configuration.modelId,
    postCallSummaryInstructions: configuration.instructions,
    postCallIncludeTranscript: configuration.includeTranscript,
    postCallIncludeSummary: configuration.includeSummary,
  };
}

