import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION,
  templateEngineDecisionJsonSchema,
  templateEngineDecisionTypes,
  validateTemplateEngineDecision,
} from '../src/voice/interaction/template-engine-decision-contract.js';

assert.equal(TEMPLATE_ENGINE_DECISION_CONTRACT_VERSION, 1);
assert.deepEqual(Object.values(templateEngineDecisionTypes), [
  'RESPONSE', 'CLARIFY', 'SEARCH', 'TOOL',
]);
assert.equal(templateEngineDecisionJsonSchema.additionalProperties, false);
assert.deepEqual(templateEngineDecisionJsonSchema.required, [
  'decision', 'response', 'clarification', 'search', 'tool', 'stateUpdate',
]);
const searchObjectSchema = templateEngineDecisionJsonSchema.properties.search.oneOf[1];
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
    stateUpdate: { set: { currentReference: 'record-id' }, clear: ['pendingQuestion'] },
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

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-decision-contract.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false, `Contract contains domain vocabulary: ${forbidden}`);
}

console.log('Template-engine decision contract verification passed.');
