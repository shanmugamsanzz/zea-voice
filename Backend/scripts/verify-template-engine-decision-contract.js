import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION,
  templateEngineDecisionJsonSchema,
  templateEngineDecisionTypes,
  validateTemplateEngineDecision,
} from '../src/voice/interaction/template-engine-decision-contract.js';
import { templateEnginePostSearchJsonSchema } from '../src/voice/interaction/template-engine-post-search-contract.js';
import { templateEngineClaimValidationJsonSchema } from '../src/voice/interaction/template-engine-claim-validator.js';
import { templateEngineWorkflowSpeechJsonSchema } from '../src/voice/interaction/template-engine-workflow-runtime.js';

assert.equal(TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION, 1);
assert.deepEqual(Object.values(templateEngineDecisionTypes), [
  'RESPONSE', 'CLARIFY', 'SEARCH', 'TOOL',
]);
assert.equal(templateEngineDecisionJsonSchema.additionalProperties, false);
assert.deepEqual(templateEngineDecisionJsonSchema.required, [
  'decision', 'response', 'clarification', 'search', 'tool', 'stateUpdate',
]);
const searchObjectSchema = templateEngineDecisionJsonSchema.properties.search.anyOf[1];
assert.deepEqual(searchObjectSchema.required, [
  'query', 'requestedFact', 'contextualReference', 'preferredRecordIds',
]);

const searchDecision = {
  decision: 'SEARCH',
  response: '',
  clarification: null,
  search: { query: 'current caller request', requestedFact: null, contextualReference: null },
  tool: null,
  stateUpdate: null,
};
assert.equal(validateTemplateEngineDecision(JSON.stringify(searchDecision)).valid, true);
assert.deepEqual(validateTemplateEngineDecision(searchDecision).value.search.preferredRecordIds, []);

for (const decision of [
  {
    decision: 'RESPONSE', response: 'Hello.', clarification: null,
    search: null, tool: null, stateUpdate: null,
  },
  {
    decision: 'CLARIFY', response: '',
    clarification: { question: 'Which option do you mean?', reason: null, candidates: [] },
    search: null, tool: null, stateUpdate: null,
  },
  {
    decision: 'TOOL', response: '', clarification: null, search: null,
    tool: { name: 'assigned_action', arguments: {} },
    stateUpdate: { set: { confirmationStatus: 'confirmed' }, clear: [] },
  },
]) {
  assert.equal(validateTemplateEngineDecision(decision).valid, true);
}

assert.equal(validateTemplateEngineDecision({ ...searchDecision, decision: 'search' }).reason,
  'invalid_decision');
assert.equal(validateTemplateEngineDecision({ ...searchDecision, extra: true }).reason,
  'invalid_shape');
assert.equal(validateTemplateEngineDecision({ ...searchDecision, response: 'unsupported branch' }).reason,
  'mixed_decision_payload');
assert.equal(validateTemplateEngineDecision({ ...searchDecision, search: null }).reason,
  'mixed_decision_payload');
assert.equal(validateTemplateEngineDecision('```json\n{}\n```').reason, 'invalid_json');
assert.equal(validateTemplateEngineDecision({
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'assigned_action', arguments: {}, unexpected: true }, stateUpdate: null,
}).reason, 'invalid_payload');
assert.deepEqual(validateTemplateEngineDecision({
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'assigned_action', arguments: '{"field":"caller value"}' },
  stateUpdate: null,
}).value.tool.arguments, { field: 'caller value' });
assert.equal(validateTemplateEngineDecision({
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'assigned_action', arguments: '{}' },
  stateUpdate: { set: { unsupportedState: true }, clear: [] },
}).reason, 'invalid_payload');

const unsupportedProviderKeywords = new Set([
  '$schema', 'title', 'oneOf', 'allOf', 'if', 'then', 'else',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
]);
function assertStrictProviderSchema(value, path = 'schema') {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    assert.equal(unsupportedProviderKeywords.has(key), false,
      `Unsupported provider schema keyword ${path}.${key}`);
  }
  if (value.type === 'object') {
    assert.equal(value.additionalProperties, false,
      `Strict provider object must reject extra fields at ${path}`);
    const propertyKeys = Object.keys(value.properties ?? {}).sort();
    assert.deepEqual([...(value.required ?? [])].sort(), propertyKeys,
      `Strict provider object must require every property at ${path}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) child.forEach((entry, index) => (
      assertStrictProviderSchema(entry, `${path}.${key}[${index}]`)
    ));
    else if (child && typeof child === 'object') {
      assertStrictProviderSchema(child, `${path}.${key}`);
    }
  }
}
assertStrictProviderSchema(templateEngineDecisionJsonSchema);
assertStrictProviderSchema(templateEnginePostSearchJsonSchema);
assertStrictProviderSchema(templateEngineClaimValidationJsonSchema);
assertStrictProviderSchema(templateEngineWorkflowSpeechJsonSchema);

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-decision-contract.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false, `Contract contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine decision contract verification passed.');
