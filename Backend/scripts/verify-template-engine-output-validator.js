import assert from 'node:assert/strict';
import { validateTemplateEngineOutput } from '../src/voice/interaction/template-engine-output-validator.js';

const evidence = Object.freeze([Object.freeze({
  verified: true, callerFacing: true, evidenceId: 'E1', recordId: 'record-1',
  canonicalName: 'Configured Alpha', aliases: Object.freeze(['Alpha']),
  content: 'Configured Alpha costs 125 units and includes Feature Delta.',
  authoritativeData: Object.freeze({ price: 125, feature: 'Feature Delta' }),
})]);
const decision = (response, evidenceIds = ['E1']) => Object.freeze({
  decision: 'RESPONSE', response, clarification: null,
  evidenceIds: Object.freeze(evidenceIds), nextQuestion: null, stateUpdate: null,
});
const validate = (value, additions = {}) => validateTemplateEngineOutput({
  phase: 'post_search', decision: value, factualClaimsPresent: true,
  selectedEvidence: evidence, requiredEvidenceRecordIds: ['record-1'],
  publishedEntities: evidence, requestedFactAvailable: true,
  maximumSpeechCharacters: 200, deterministicOnly: true, ...additions,
});

assert.equal(validate(decision('Configured Alpha costs 125 units.')).valid, true);
assert.equal(validate(decision('Configured Alpha costs 999 units.')).reason,
  'unsupported_numeric_claim');
assert.equal(validate(decision('Configured Alpha costs 125 units.', ['unknown'])).reason,
  'unknown_evidence_id');
assert.equal(validate(decision('Configured Alpha costs 125 units.'), {
  requiredEvidenceRecordIds: ['record-2'],
}).reason, 'comparison_requires_exact_requested_records');
assert.equal(validate(decision('Configured Alpha costs 125 units and includes Feature Delta.'), {
  maximumSpeechCharacters: 20,
}).reason, 'speech_budget_exceeded');

console.log(JSON.stringify({
  suite: 'template-engine-output-validator', passed: true,
  checks: ['evidence', 'entity', 'citation', 'number', 'relevance', 'length'],
}));
