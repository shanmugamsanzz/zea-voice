export const TEMPLATE_ENGINE_TOOL_RESULT_VALIDATOR_VERSION = 1;

function cleanText(value, maximum = 4_000) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function identity(value) {
  return cleanText(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

function internalOrJson(value) {
  const speech = cleanText(value);
  if (!speech) return true;
  if (/```|<(?:platform|tenant|orchestrator|workflow|runtime)_[^>]*>/iu.test(speech)
    || /"(?:decision|stateUpdate|evidenceIds|tool|search)"\s*:/iu.test(speech)) return true;
  if ((speech.startsWith('{') && speech.endsWith('}'))
    || (speech.startsWith('[') && speech.endsWith(']'))) {
    try { JSON.parse(speech); return true; } catch { /* natural speech punctuation */ }
  }
  return false;
}

function numbers(value) {
  return new Set(cleanText(value).match(/[+-]?\p{N}+(?:[.,]\p{N}+)?/gu) ?? []);
}

function invalid(reason) {
  return Object.freeze({ valid: false, ttsAllowed: false, route: 'REJECT', reason });
}

export function validateTemplateEngineToolResultSpeech({
  speech, verifiedResult, successIndicators = [], callerProvidedValues = {},
  semanticClaimValidation = null,
} = {}) {
  const spoken = cleanText(speech);
  if (!spoken || internalOrJson(spoken)) return invalid('invalid_tool_result_speech');
  if (!verifiedResult || typeof verifiedResult !== 'object'
    || verifiedResult.verified !== true || typeof verifiedResult.success !== 'boolean') {
    return invalid('tool_result_unverified');
  }
  const permittedNumbers = new Set([
    ...numbers(JSON.stringify(verifiedResult.output ?? null)),
    ...numbers(JSON.stringify(verifiedResult.error ?? null)),
    ...numbers(JSON.stringify(callerProvidedValues ?? {})),
  ]);
  if ([...numbers(spoken)].some((number) => !permittedNumbers.has(number))) {
    return invalid('unsupported_tool_result_number');
  }
  if (!verifiedResult.success) {
    const normalizedSpeech = identity(spoken);
    const indicators = (Array.isArray(successIndicators) ? successIndicators : [])
      .map(identity).filter(Boolean);
    if (indicators.some((indicator) => normalizedSpeech.includes(indicator))) {
      return invalid('success_claim_after_failed_tool');
    }
    if (semanticClaimValidation?.successClaimed === true) {
      return invalid('success_claim_after_failed_tool');
    }
  }
  if (semanticClaimValidation?.supported !== true) {
    return invalid(semanticClaimValidation
      ? 'unsupported_tool_result_claim' : 'tool_result_grounding_validation_missing');
  }
  return Object.freeze({
    valid: true, ttsAllowed: true, route: 'TTS', value: Object.freeze({ speech: spoken }),
  });
}
