import { templateEngineStructuredOutputFailureCodes } from './template-engine-structured-output.js';

const validationCodes = new Set([
  ...templateEngineStructuredOutputFailureCodes,
  'TEMPLATE_ENGINE_OUTPUT_INVALID', 'TEMPLATE_ENGINE_POST_SEARCH_INVALID',
  'TEMPLATE_ENGINE_SPEECH_BUDGET_EXCEEDED',
  'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID', 'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID',
  'TEMPLATE_ENGINE_WORKFLOW_SPEECH_INVALID', 'TEMPLATE_ENGINE_WORKFLOW_RESULT_SPEECH_INVALID',
  'TEMPLATE_ENGINE_EVIDENCE_ALIAS_INVALID',
  'TEMPLATE_ENGINE_CLAIM_VALIDATION_INVALID', 'TEMPLATE_ENGINE_GROUNDING_REJECTED',
  'TEMPLATE_ENGINE_REQUESTED_ENTITY_COVERAGE_INCOMPLETE',
  'TEMPLATE_ENGINE_REQUESTED_ENTITY_HYDRATION_INCOMPLETE',
  'TEMPLATE_ENGINE_AUTHORITATIVE_EVIDENCE_EMPTY',
  'TEMPLATE_ENGINE_HYDRATED_EVIDENCE_INVALID',
  'TEMPLATE_ENGINE_WORKFLOW_CONFIRMATION_CONFIGURATION_MISSING',
  'TEMPLATE_ENGINE_WORKFLOW_FIELD_CONFIGURATION_MISSING',
]);
const operationalCodes = new Set([
  'LLM_PROVIDER_TIMEOUT', 'LLM_PROVIDER_UNAVAILABLE', 'LLM_PROVIDER_REQUEST_FAILED',
  'TTS_PROVIDER_TIMEOUT', 'TTS_PROVIDER_UNAVAILABLE', 'TTS_PROVIDER_REQUEST_FAILED',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

// Status 5xx alone is not proof of an infrastructure outage. Validation errors
// historically used the same status and must never authorize technical speech.
export function classifyTemplateEngineTurnError(error, { stale = false } = {}) {
  if (stale) return 'cancelled';
  const chain = [];
  const seen = new Set();
  for (let entry = error; entry && !seen.has(entry); entry = entry.cause) {
    seen.add(entry);
    chain.push(entry);
  }
  if (chain.some((entry) => entry.name === 'AbortError'
    || ['ABORT_ERR', 'ERR_CANCELED', 'TEMPLATE_ENGINE_LLM_CANCELLED'].includes(entry.code))) {
    return 'cancelled';
  }
  if (chain.some((entry) => validationCodes.has(entry.code))) return 'validation';
  if (chain.some((entry) => operationalCodes.has(entry.code)
    // PostgreSQL connection failures and server shutdowns.
    || /^(08[0-9A-Z]{3}|57P0[123])$/u.test(String(entry.code ?? '')))) return 'operational';
  return 'unclassified';
}
