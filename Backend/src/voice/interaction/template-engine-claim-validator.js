import { AppError } from '../../middleware/errors.js';

export const TEMPLATE_ENGINE_CLAIM_VALIDATOR_VERSION = 1;

export const templateEngineClaimValidationJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['supported', 'successClaimed', 'reason']),
  properties: Object.freeze({
    supported: Object.freeze({ type: 'boolean' }),
    successClaimed: Object.freeze({ type: 'boolean' }),
    reason: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'string' }),
        Object.freeze({ type: 'null' }),
      ]),
    }),
  }),
});

function parsed(value) {
  const candidate = value?.outputParsed ?? value?.output_parsed ?? value?.parsed
    ?? value?.output ?? value;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  if (typeof candidate !== 'string') return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

export async function validateTemplateEngineClaims({
  speech, evidence = null, verifiedToolResult = null, callerValues = null,
} = {}, dependencies = {}) {
  if (typeof dependencies.invokeStructuredLlm !== 'function') {
    throw new TypeError('Claim validation requires the configured structured LLM');
  }
  const reference = verifiedToolResult
    ? { kind: 'verified_tool_result', verifiedToolResult, callerValues }
    : { kind: 'published_evidence', evidence };
  const completion = await dependencies.invokeStructuredLlm(Object.freeze({
    messages: Object.freeze([Object.freeze({
      role: 'system',
      content: [
        'Validate caller-facing speech against only the supplied reference JSON.',
        'supported is true only when every factual claim is directly entailed by that reference.',
        'For a tool result, successClaimed is true when the speech says or implies the action succeeded.',
        'Do not use outside knowledge. Return only the required JSON object.',
        '<validation_input>',
        JSON.stringify({ speech, reference }),
        '</validation_input>',
      ].join('\n'),
    })]),
    temperature: 0,
    responseFormat: Object.freeze({
      type: 'json_schema', name: 'template_engine_claim_validation', strict: true,
      schema: templateEngineClaimValidationJsonSchema,
    }),
  }));
  const result = parsed(completion);
  if (!result || typeof result.supported !== 'boolean'
    || typeof result.successClaimed !== 'boolean'
    || !(typeof result.reason === 'string' || result.reason === null)) {
    throw new AppError(502, 'The grounding validator returned an invalid decision',
      'TEMPLATE_ENGINE_CLAIM_VALIDATION_INVALID');
  }
  return Object.freeze({
    supported: result.supported,
    successClaimed: result.successClaimed,
    reason: result.reason,
  });
}
