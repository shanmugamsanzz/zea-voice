import { templateEngineStructuredOutputFailureCodes } from './template-engine-structured-output.js';

const actionCodes = new Set([
  'QDRANT_UNIVERSAL_LLM_ACTION_NOT_AUTHORIZED',
  'QDRANT_UNIVERSAL_LLM_WORKFLOW_INVALID', 'QDRANT_UNIVERSAL_LLM_WORKFLOW_NOT_AUTHORIZED',
  'QDRANT_UNIVERSAL_LLM_WORKFLOW_ARGUMENTS_INVALID',
  'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_READY', 'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_CONFLICT',
  'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_AUTHORIZED', 'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_ARGUMENTS_INVALID',
]);
const operationalCodes = new Set([
  ...templateEngineStructuredOutputFailureCodes,
  'QDRANT_UNIVERSAL_LLM_SCHEMA_INVALID', 'QDRANT_UNIVERSAL_LLM_EMPTY',
  'LLM_PROVIDER_TIMEOUT', 'LLM_PROVIDER_UNAVAILABLE', 'LLM_PROVIDER_REQUEST_FAILED',
  'VOICE_RETRIEVAL_DEADLINE', 'VOICE_LLM_FIRST_SENTENCE_TIMEOUT',
  'TTS_PROVIDER_TIMEOUT', 'TTS_PROVIDER_UNAVAILABLE', 'TTS_PROVIDER_REQUEST_FAILED',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
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
  if (chain.some((entry) => actionCodes.has(entry.code))) return 'action';
  if (chain.some((entry) => operationalCodes.has(entry.code)
    // PostgreSQL connection failures and server shutdowns.
    || /^(08[0-9A-Z]{3}|57P0[123])$/u.test(String(entry.code ?? '')))) return 'operational';
  // Unknown exceptions are genuine runtime/system failures.
  return 'unexpected';
}
