import assert from 'node:assert/strict';
import {
  templateEnginePostSearchJsonSchema,
  validateTemplateEnginePostSearchDecision,
} from '../src/voice/interaction/template-engine-post-search-contract.js';
import { respondToTemplateEngineSearch } from '../src/voice/interaction/template-engine-orchestrator.js';

const mainPrompt = 'Use concise natural speech. Explain missing information naturally.';
const latestUtterance = 'What is its current price?';
const state = Object.freeze({
  recentCompleteTurns: Object.freeze([
    Object.freeze({ role: 'user', content: 'Explain the selected service.' }),
    Object.freeze({ role: 'assistant', content: 'Here is the verified explanation.' }),
  ]),
  lastReferencedRecordIds: Object.freeze(['record-1']),
  comparisonRecordIds: Object.freeze([]), pendingClarification: null,
  activeWorkflowId: null, collectedToolFields: Object.freeze({}), confirmationStatus: null,
});
const searchDecision = Object.freeze({
  decision: 'SEARCH', response: '', clarification: null,
  search: Object.freeze({
    query: 'selected service current price', requestedFact: 'price',
    contextualReference: 'selected service', preferredRecordIds: ['record-1'],
  }),
  tool: null, stateUpdate: null,
});
const scope = Object.freeze({
  tenantId: 'tenant-a', agentId: 'agent-a',
  publications: Object.freeze([
    Object.freeze({ knowledgeBaseId: 'kb-a', publicationRevision: 2 }),
  ]),
});
const verifiedEvidence = Object.freeze([
  Object.freeze({
    verified: true, callerFacing: true, evidenceId: 'evidence-1', recordId: 'record-1',
    recordType: 'ITEM', tenantId: 'tenant-a', agentId: 'agent-a',
    knowledgeBaseId: 'kb-a', publicationRevision: 2,
    content: 'The selected service currently costs 3200 currency units.',
  }),
]);

assert.deepEqual(templateEnginePostSearchJsonSchema.properties.decision.enum,
  ['RESPONSE', 'CLARIFY', 'NO_MATCH']);
assert.equal(Object.hasOwn(templateEnginePostSearchJsonSchema.properties, 'tool'), false);
assert.equal(Object.hasOwn(templateEnginePostSearchJsonSchema.properties, 'search'), false);

let calls = 0;
let providerRequest;
let groundedClaimInput;
let postSearchDiagnostics;
const result = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async (input) => {
    groundedClaimInput = input;
    return { supported: true };
  },
  invokeStructuredLlm: async (request) => {
    calls += 1;
    providerRequest = request;
    return {
      outputParsed: {
        decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
        clarification: null, evidenceIds: ['E1'], stateUpdate: null,
      },
    };
  },
  onPostSearchDiagnostics: (details) => { postSearchDiagnostics = details; },
});
assert.equal(calls, 1);
assert.equal(result.decision.decision, 'RESPONSE');
assert.deepEqual(result.decision.evidenceIds, ['evidence-1']);
assert.deepEqual(groundedClaimInput.evidenceIds, ['evidence-1']);
assert.deepEqual(postSearchDiagnostics.allowedAliases, ['E1']);
assert.deepEqual(postSearchDiagnostics.returnedAliases, ['E1']);
assert.equal(postSearchDiagnostics.validationReason, null);
assert.equal(postSearchDiagnostics.finalDecision, 'RESPONSE');
assert.equal(result.input.verifiedEvidence.length, 1);
assert.equal(result.input.searchInterpretation.requestedFact, 'price');
assert.match(providerRequest.messages[0].content, /template_engine_post_search_decision|post-search phase/u);
assert.match(providerRequest.messages[0].content, /Explain the selected service/u);
assert.match(providerRequest.messages[0].content, /The selected service currently costs/u);
assert.match(providerRequest.messages[0].content, /"evidenceId":"E1"/u);
assert.doesNotMatch(providerRequest.messages[0].content, /evidence-1/u,
  'Real evidence IDs must not be exposed as provider-facing citation tokens');
assert.deepEqual(providerRequest.responseFormat.schema.properties.evidenceIds.items.enum, ['E1']);

assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'Unsupported.', clarification: null,
  evidenceIds: [], stateUpdate: null,
}, ['evidence-1']).reason, 'mixed_decision_payload');
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'Wrong citation.', clarification: null,
  evidenceIds: ['unknown'], stateUpdate: null,
}, ['evidence-1']).reason, 'unknown_evidence_id');
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'NO_MATCH', response: 'I do not have that information right now.',
  clarification: null, evidenceIds: [], stateUpdate: null,
}, []).valid, true);
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'CLARIFY', response: '',
  clarification: { question: 'Which service do you mean?', reason: null, candidates: [] },
  evidenceIds: [], stateUpdate: null,
}, []).valid, true);
const normalizedResponse = validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'The current price is supported.',
  clarification: { question: 'Ignore this?', reason: null, candidates: [] },
  evidenceIds: ['evidence-1'], stateUpdate: null,
}, ['evidence-1']);
assert.equal(normalizedResponse.valid, true);
assert.equal(normalizedResponse.value.clarification, null,
  'Inactive clarification payload must not invalidate a grounded RESPONSE');
const normalizedClarification = validateTemplateEnginePostSearchDecision({
  decision: 'CLARIFY', response: 'Inactive response text.',
  clarification: { question: 'Which service do you mean?', reason: null, candidates: [] },
  evidenceIds: ['evidence-1'], stateUpdate: null,
}, ['evidence-1']);
assert.equal(normalizedClarification.valid, true);
assert.equal(normalizedClarification.value.response, '');
assert.deepEqual(normalizedClarification.value.evidenceIds, []);
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'TOOL', response: '', clarification: null,
  evidenceIds: [], stateUpdate: null,
}, []).reason, 'invalid_decision');

await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision,
  verifiedEvidence: [{ ...verifiedEvidence[0], tenantId: 'tenant-b' }], scope,
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => { throw new Error('must not be invoked'); },
}), (error) => error.code === 'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_VIOLATION');

let repairCalls = 0;
const repaired = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true }),
  invokeStructuredLlm: async () => {
    repairCalls += 1;
    return repairCalls === 1 ? {
      outputParsed: {
        decision: 'RESPONSE', response: 'A factual answer with a forbidden real identifier.',
        clarification: null, evidenceIds: ['evidence-1'], stateUpdate: null,
      },
    } : {
      outputParsed: {
        decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
        clarification: null, evidenceIds: ['E1'], stateUpdate: null,
      },
    };
  },
});
assert.equal(repairCalls, 2, 'An invalid post-search branch must receive one repair attempt');
assert.equal(repaired.decision.decision, 'RESPONSE');
assert.deepEqual(repaired.decision.evidenceIds, ['evidence-1']);

let fallbackCalls = 0;
let fallbackDiagnostics;
await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => {
    fallbackCalls += 1;
    return {
      outputParsed: {
        decision: 'RESPONSE', response: 'Unsupported factual response.',
        clarification: null, evidenceIds: [], stateUpdate: null,
      },
    };
  },
  onDecisionRepair: (details) => { fallbackDiagnostics = details; },
}), (error) => error.code === 'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID'
  && error.details?.reason === 'mixed_decision_payload');
assert.equal(fallbackCalls, 2);
assert.equal(fallbackDiagnostics.recovered, false);
assert.equal(fallbackDiagnostics.configuredFallbackApplied, false);
assert.equal(fallbackDiagnostics.first.responsePresent, true);
assert.equal(fallbackDiagnostics.first.evidenceIdCount, 0);

let changedDecisionCalls = 0;
await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => {
    changedDecisionCalls += 1;
    return changedDecisionCalls === 1 ? { outputParsed: {
      decision: 'RESPONSE', response: 'A supported answer without its citation.',
      clarification: null, evidenceIds: [], stateUpdate: null,
    } } : { outputParsed: {
      decision: 'NO_MATCH', response: 'That information is unavailable.',
      clarification: null, evidenceIds: [], stateUpdate: null,
    } };
  },
}), (error) => error.code === 'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID'
  && error.details?.reason === 'citation_repair_changed_decision');
assert.equal(changedDecisionCalls, 2);

const emptyEvidenceFallback = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence: [], scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'RESPONSE', response: 'An unsupported answer.',
    clarification: null, evidenceIds: [], stateUpdate: null,
  } }),
});
assert.equal(emptyEvidenceFallback.decision.decision, 'NO_MATCH');
assert.equal(emptyEvidenceFallback.decision.response,
  'That information is not available right now.');

console.log('Template-engine post-search Orchestrator verification passed.');
