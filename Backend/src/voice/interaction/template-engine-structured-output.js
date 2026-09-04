import { AppError } from '../../middleware/errors.js';
import {
  normalizeTemplateEngineProviderEnvelope,
  validateTemplateEngineDecision,
} from './template-engine-decision-contract.js';

const truncatedFinishReasons = new Set([
  'length', 'max_tokens', 'max_output_tokens', 'max_tokens_reached', 'incomplete',
]);

export const templateEngineStructuredOutputFailureCodes = Object.freeze(new Set([
  'TEMPLATE_ENGINE_LLM_INCOMPLETE',
  'TEMPLATE_ENGINE_LLM_TRUNCATED',
  'TEMPLATE_ENGINE_LLM_EMPTY',
  'TEMPLATE_ENGINE_LLM_INVALID_JSON',
  'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID',
]));

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return { valid: true };
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf.map((candidate) => validateSchema(value, candidate, path));
    return alternatives.some((candidate) => candidate.valid)
      ? { valid: true }
      : { valid: false, reason: 'any_of', path };
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return { valid: false, reason: 'enum', path };
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    return { valid: false, reason: 'type', path };
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        return { valid: false, reason: 'required', path: `${path}.${required}` };
      }
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unexpected) {
        return { valid: false, reason: 'additional_property', path: `${path}.${unexpected}` };
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const result = validateSchema(value[key], child, `${path}.${key}`);
      if (!result.valid) return result;
    }
  }
  if (schema.type === 'array' && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const result = validateSchema(value[index], schema.items, `${path}[${index}]`);
      if (!result.valid) return result;
    }
  }
  return { valid: true };
}

function isInitialDecisionSchema(schema) {
  const properties = schema?.properties;
  return schema?.type === 'object'
    && properties && Object.hasOwn(properties, 'decision')
    && Object.hasOwn(properties, 'search') && Object.hasOwn(properties, 'tool');
}

export function parseTemplateEngineStructuredOutput({ completion, output, schema } = {}) {
  const finishReason = String(completion?.finishReason ?? '').trim().toLocaleLowerCase();
  if (completion?.type !== 'completed') {
    throw new AppError(502, 'The template-engine LLM stream ended without completion',
      'TEMPLATE_ENGINE_LLM_INCOMPLETE', { finishReason: finishReason || null });
  }
  if (truncatedFinishReasons.has(finishReason)) {
    throw new AppError(502, 'The template-engine LLM response was truncated',
      'TEMPLATE_ENGINE_LLM_TRUNCATED', { finishReason });
  }
  const raw = String(output ?? '').trim();
  if (!raw) {
    throw new AppError(502, 'The template-engine LLM returned no decision',
      'TEMPLATE_ENGINE_LLM_EMPTY', { finishReason: finishReason || null });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(502, 'The template-engine LLM returned malformed JSON',
      'TEMPLATE_ENGINE_LLM_INVALID_JSON', {
        finishReason: finishReason || null,
        message: String(error?.message ?? '').slice(0, 240),
      });
  }
  if (isInitialDecisionSchema(schema)) {
    parsed = normalizeTemplateEngineProviderEnvelope(parsed) ?? parsed;
  }
  const validation = validateSchema(parsed, schema);
  if (!validation.valid) {
    throw new AppError(502, 'The template-engine LLM response did not match its schema',
      'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID', {
        finishReason: finishReason || null,
        reason: validation.reason,
        path: validation.path,
      });
  }
  if (isInitialDecisionSchema(schema)) {
    const decisionValidation = validateTemplateEngineDecision(parsed);
    if (!decisionValidation.valid) {
      throw new AppError(502, 'The template-engine LLM response has no usable active route',
        'TEMPLATE_ENGINE_LLM_SCHEMA_INVALID', {
          finishReason: finishReason || null,
          reason: decisionValidation.reason,
          path: '$',
        });
    }
    return decisionValidation.value;
  }
  return parsed;
}

export function isTemplateEngineStructuredOutputFailure(error) {
  return templateEngineStructuredOutputFailureCodes.has(error?.code);
}

export function structuredOutputRetryMessages(messages, error) {
  return Object.freeze([
    ...(Array.isArray(messages) ? messages : []),
    Object.freeze({
      role: 'system',
      content: [
        'The previous structured response was unusable.',
        `Failure: ${String(error?.code ?? 'invalid_structured_output')}.`,
        'Return exactly one complete JSON object matching the same supplied schema.',
        'Do not omit required fields and do not include markdown or commentary.',
      ].join(' '),
    }),
  ]);
}
