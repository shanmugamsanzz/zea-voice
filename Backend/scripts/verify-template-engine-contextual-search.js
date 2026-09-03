import assert from 'node:assert/strict';
import { normalizeTemplateEngineSearchDecision } from '../src/voice/interaction/template-engine-search-request.js';

const state = Object.freeze({
  lastReferencedRecordIds: Object.freeze(['silver-record']),
  comparisonRecordIds: Object.freeze([]),
});
const contextualSearch = normalizeTemplateEngineSearchDecision({
  decision: 'SEARCH', response: '', clarification: null,
  search: {
    query: 'Silver Master Health Checkup price',
    requestedFact: 'price',
    contextualReference: 'Silver Master Health Checkup',
  },
  tool: null, stateUpdate: null,
}, state);
assert.equal(contextualSearch.valid, true);
assert.equal(contextualSearch.value.search.query, 'Silver Master Health Checkup price');
assert.equal(contextualSearch.value.search.requestedFact, 'price');
assert.equal(contextualSearch.value.search.contextualReference, 'Silver Master Health Checkup');
assert.deepEqual(contextualSearch.value.search.preferredRecordIds, ['silver-record']);

const explicitPreference = normalizeTemplateEngineSearchDecision({
  decision: 'SEARCH', response: '', clarification: null,
  search: {
    query: 'compare selected records', requestedFact: 'difference',
    contextualReference: 'selected records', preferredRecordIds: ['first', 'second'],
  },
  tool: null, stateUpdate: null,
}, {
  lastReferencedRecordIds: [], comparisonRecordIds: ['first', 'second'],
});
assert.equal(explicitPreference.valid, true);
assert.deepEqual(explicitPreference.value.search.preferredRecordIds, ['first', 'second']);

const inventedPreference = normalizeTemplateEngineSearchDecision({
  decision: 'SEARCH', response: '', clarification: null,
  search: {
    query: 'current fact', requestedFact: 'fact', contextualReference: null,
    preferredRecordIds: ['invented-record'],
  },
  tool: null, stateUpdate: null,
}, state);
assert.equal(inventedPreference.reason, 'unknown_preferred_record_id');

const unsupportedClarification = normalizeTemplateEngineSearchDecision({
  decision: 'CLARIFY', response: '',
  clarification: {
    question: 'Which one?', reason: 'contextual_reference_ambiguous', candidates: ['Only one'],
  },
  search: null, tool: null, stateUpdate: null,
}, state);
assert.equal(unsupportedClarification.reason,
  'contextual_clarification_requires_candidates');
const genuineClarification = normalizeTemplateEngineSearchDecision({
  decision: 'CLARIFY', response: '',
  clarification: {
    question: 'Do you mean the first or second option?',
    reason: 'contextual_reference_ambiguous', candidates: ['First option', 'Second option'],
  },
  search: null, tool: null, stateUpdate: null,
}, state);
assert.equal(genuineClarification.valid, true);

console.log('Template-engine contextual SEARCH verification passed.');

