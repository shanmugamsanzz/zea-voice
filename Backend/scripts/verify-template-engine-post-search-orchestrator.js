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
  tool: null, nextQuestion: null, stateUpdate: null,
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
        clarification: null, evidenceIds: ['E1'],
        nextQuestion: {
          question: 'Would you like details about this service?',
          reason: 'conversation_guidance',
        },
        stateUpdate: null,
      },
    };
  },
  onPostSearchDiagnostics: (details) => { postSearchDiagnostics = details; },
});
assert.equal(calls, 1);
assert.equal(result.decision.decision, 'RESPONSE');
assert.equal(result.decision.nextQuestion.question,
  'Would you like details about this service?');
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

const secondEvidence = Object.freeze({
  ...verifiedEvidence[0],
  evidenceId: 'evidence-2',
  recordId: 'record-2',
  canonicalName: 'Second Service',
  aliases: Object.freeze(['Second']),
  relationships: Object.freeze([]),
  authoritativeData: Object.freeze({ name: 'Second Service', price: 4100 }),
  content: 'The second service currently costs 4100 currency units.',
});
let comparisonClaimInput;
const comparisonResult = await respondToTemplateEngineSearch({
  mainPrompt,
  latestUtterance: 'Compare the first and second services.',
  state: {
    ...state,
    lastReferencedRecordIds: [],
    comparisonRecordIds: ['record-1', 'record-2'],
  },
  searchDecision: {
    ...searchDecision,
    search: {
      query: 'first service second service comparison',
      requestedFact: 'differences',
      contextualReference: 'first and second services',
      preferredRecordIds: ['record-1', 'record-2'],
    },
  },
  verifiedEvidence: [verifiedEvidence[0], secondEvidence],
  scope,
}, {
  tenantBoundaryVerified: true,
  publishedEntities: [
    { recordId: 'record-1', canonicalName: 'First Service' },
    { recordId: 'record-2', canonicalName: 'Second Service' },
  ],
  validateGroundedClaims: async (input) => {
    comparisonClaimInput = input;
    return { supported: true };
  },
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'RESPONSE',
    response: 'The first service costs 3200 units, while the second costs 4100 units.',
    clarification: null,
    evidenceIds: ['E1', 'E2'],
    nextQuestion: null,
    stateUpdate: null,
  } }),
});
assert.equal(comparisonResult.decision.decision, 'RESPONSE');
assert.deepEqual(comparisonResult.decision.evidenceIds, ['evidence-1', 'evidence-2']);
assert.equal(comparisonClaimInput.selectedEvidence.length, 2,
  'Grounded comparison validation must receive the complete selected evidence set');
assert.equal(comparisonClaimInput.selectedEvidence[1].canonicalName, 'Second Service');
assert.deepEqual(comparisonClaimInput.selectedEvidence[1].authoritativeData,
  { name: 'Second Service', price: 4100 });

assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'Unsupported.', clarification: null,
  evidenceIds: [], nextQuestion: null, stateUpdate: null,
}, ['evidence-1']).reason, 'mixed_decision_payload');
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'Wrong citation.', clarification: null,
  evidenceIds: ['unknown'], nextQuestion: null, stateUpdate: null,
}, ['evidence-1']).reason, 'unknown_evidence_id');
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'NO_MATCH', response: 'I do not have that information right now.',
  clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
}, []).valid, true);
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'CLARIFY', response: '',
  clarification: { question: 'Which service do you mean?', reason: null, candidates: [] },
  evidenceIds: [], nextQuestion: null, stateUpdate: null,
}, []).valid, true);
const normalizedResponse = validateTemplateEnginePostSearchDecision({
  decision: 'RESPONSE', response: 'The current price is supported.',
  clarification: { question: 'Ignore this?', reason: null, candidates: [] },
  evidenceIds: ['evidence-1'], nextQuestion: null, stateUpdate: null,
}, ['evidence-1']);
assert.equal(normalizedResponse.valid, true);
assert.equal(normalizedResponse.value.clarification, null,
  'Inactive clarification payload must not invalidate a grounded RESPONSE');
const normalizedClarification = validateTemplateEnginePostSearchDecision({
  decision: 'CLARIFY', response: 'Inactive response text.',
  clarification: { question: 'Which service do you mean?', reason: null, candidates: [] },
  evidenceIds: ['evidence-1'], nextQuestion: null, stateUpdate: null,
}, ['evidence-1']);
assert.equal(normalizedClarification.valid, true);
assert.equal(normalizedClarification.value.response, '');
assert.deepEqual(normalizedClarification.value.evidenceIds, []);
assert.equal(validateTemplateEnginePostSearchDecision({
  decision: 'TOOL', response: '', clarification: null,
  evidenceIds: [], nextQuestion: null, stateUpdate: null,
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
        clarification: null, evidenceIds: ['evidence-1'], nextQuestion: null, stateUpdate: null,
      },
    } : {
      outputParsed: {
        decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
        clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
      },
    };
  },
});
assert.equal(repairCalls, 2, 'An invalid post-search branch must receive one repair attempt');
assert.equal(repaired.decision.decision, 'RESPONSE');
assert.deepEqual(repaired.decision.evidenceIds, ['evidence-1']);

let groundedRepairCalls = 0;
let groundedValidationCalls = 0;
const groundedNoMatch = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async (input) => {
    groundedValidationCalls += 1;
    return input.decision === 'NO_MATCH'
      ? { supported: true, reason: null }
      : { supported: false, reason: 'attribute_not_supported' };
  },
  invokeStructuredLlm: async () => {
    groundedRepairCalls += 1;
    return groundedRepairCalls === 1 ? { outputParsed: {
      decision: 'RESPONSE', response: 'The service includes an unpublished attribute.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } } : { outputParsed: {
      decision: 'NO_MATCH', response: 'That detail is not available in the published information.',
      clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(groundedRepairCalls, 2,
  'An unsupported grounded response must receive exactly one repair attempt');
assert.equal(groundedValidationCalls, 2,
  'Both factual RESPONSE and NO_MATCH recovery speech must be grounded');
assert.equal(groundedNoMatch.decision.decision, 'NO_MATCH');

let negativeNoMatchCalls = 0;
const safeMissingAttribute = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance: 'Is the unpublished attribute unnecessary?',
  state, searchDecision: {
    ...searchDecision,
    search: { ...searchDecision.search, requestedFact: 'unpublished attribute' },
  },
  verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async ({ decision, response, searchInterpretation }) => ({
    supported: decision === 'NO_MATCH'
      && response === 'The published information does not provide that detail.'
      && searchInterpretation.requestedFact === 'unpublished attribute',
    reason: 'absence_does_not_support_negative_claim',
  }),
  invokeStructuredLlm: async () => {
    negativeNoMatchCalls += 1;
    return { outputParsed: negativeNoMatchCalls === 1 ? {
      decision: 'NO_MATCH', response: 'That attribute is not required.',
      clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } : {
      decision: 'NO_MATCH',
      response: 'The published information does not provide that detail.',
      clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(negativeNoMatchCalls, 2,
  'A negative claim inferred from an unpublished attribute must be repaired once');
assert.equal(safeMissingAttribute.decision.decision, 'NO_MATCH');
assert.equal(safeMissingAttribute.decision.response,
  'The published information does not provide that detail.');

let clarificationValidationInput;
const groundedClarification = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance: 'Which selected service?', state, searchDecision,
  verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  ambiguity: { required: true, kind: 'entity', candidates: ['Service Alpha', 'Service Beta'] },
  validateGroundedClaims: async (input) => {
    clarificationValidationInput = input;
    return { supported: true, reason: null };
  },
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'CLARIFY', response: '', clarification: {
      question: 'Do you mean Service Alpha or Service Beta?',
      reason: 'ambiguous reference', candidates: ['Service Alpha', 'Service Beta'],
    }, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  } }),
});
assert.equal(groundedClarification.decision.decision, 'CLARIFY');
assert.equal(clarificationValidationInput.decision, 'CLARIFY');
assert.equal(clarificationValidationInput.selectedEvidence.length, 1,
  'Clarification speech validation receives the complete verified evidence set');

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
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
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
      clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } } : { outputParsed: {
      decision: 'NO_MATCH', response: 'That information is unavailable.',
      clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
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
  validateGroundedClaims: async ({ decision, response }) => ({
    supported: decision === 'NO_MATCH'
      && response === 'That information is not available right now.',
    reason: decision === 'NO_MATCH' ? null : 'unsupported_claim',
  }),
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'RESPONSE', response: 'An unsupported answer.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  } }),
});
assert.equal(emptyEvidenceFallback.decision.decision, 'NO_MATCH');
assert.equal(emptyEvidenceFallback.decision.response,
  'That information is not available right now.');

console.log('Template-engine post-search Orchestrator verification passed.');
