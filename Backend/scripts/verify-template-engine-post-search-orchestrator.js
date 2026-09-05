import assert from 'node:assert/strict';
import {
  templateEnginePostSearchJsonSchema,
  validateTemplateEnginePostSearchDecision,
} from '../src/voice/interaction/template-engine-post-search-contract.js';
import { respondToTemplateEngineSearch } from '../src/voice/interaction/template-engine-orchestrator.js';
import { classifyTemplateEngineTurnError } from '../src/voice/interaction/template-engine-error-classification.js';

for (const code of ['TEMPLATE_ENGINE_OUTPUT_INVALID', 'TEMPLATE_ENGINE_POST_SEARCH_DECISION_INVALID',
  'TEMPLATE_ENGINE_LLM_INVALID_JSON', 'TEMPLATE_ENGINE_CLAIM_VALIDATION_INVALID']) {
  assert.equal(classifyTemplateEngineTurnError({ code, statusCode: 502 }), 'validation');
}
assert.equal(classifyTemplateEngineTurnError({ statusCode: 503 }), 'unclassified');
for (const code of ['LLM_PROVIDER_TIMEOUT', 'TTS_PROVIDER_REQUEST_FAILED', 'ECONNREFUSED', '08006']) {
  assert.equal(classifyTemplateEngineTurnError({ code }), 'operational');
  assert.equal(classifyTemplateEngineTurnError({ code }, { stale: true }), 'cancelled');
}
assert.equal(classifyTemplateEngineTurnError({ code: 'LLM_PROVIDER_UNAVAILABLE',
  cause: { name: 'AbortError' } }), 'cancelled');

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
    canonicalName: 'First Service', aliases: Object.freeze(['First']),
    content: 'The selected service currently costs 3200 currency units.',
    publishedAttributePaths: Object.freeze(['price']),
  }),
]);

let numericRepairCalls = 0;
let budgetCalls = 0;
let budgetClaimChecks = 0;
const budgetAnswer = 'The price is 3200 units. Would you like more detail?';
const budgetResult = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, scope, verifiedEvidence,
  maximumSpeechCharacters: budgetAnswer.length,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async ({ response }) => {
    budgetClaimChecks += 1;
    return { supported: response.includes('3200'), requestedFactAddressed: response.includes('price') };
  },
  invokeStructuredLlm: async ({ messages }) => {
    budgetCalls += 1;
    assert.ok(messages[0].content.includes(`${budgetAnswer.length} characters`));
    assert.ok(messages[0].content.includes('cover every requested operand'));
    if (budgetCalls === 2) assert.ok(messages.at(-1).content.includes('speech_budget_exceeded'));
    return { outputParsed: { decision: 'RESPONSE', response: budgetCalls === 1
      ? `The price is 3200 units. ${'Additional explanation. '.repeat(12)}` : budgetAnswer,
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null } };
  },
});
assert.equal(budgetCalls, 2, 'Oversized answers get one complete rewrite, not substring truncation');
assert.equal(budgetClaimChecks, 2, 'The revised answer must be independently grounded');
assert.equal(budgetResult.decision.response, budgetAnswer);
assert.deepEqual(budgetResult.decision.evidenceIds, ['evidence-1']);

await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, scope, verifiedEvidence,
  maximumSpeechCharacters: 10,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  invokeStructuredLlm: async () => ({ outputParsed: { decision: 'RESPONSE',
    response: 'The price is 3200 units.', clarification: null,
    evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null } }),
}), { code: 'TEMPLATE_ENGINE_OUTPUT_INVALID' }, 'An impossible budget must not produce a truncated factual answer');
const sixOperands = Array.from({ length: 6 }, (_, index) => ({ ...verifiedEvidence[0],
  evidenceId: `operand-${index}`, recordId: `record-${index}`, canonicalName: `Option ${index}`,
  content: 'The price is 3200 units.', authoritativeData: { price: 3200 },
}));
const completeComparison = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance: 'Compare the prices of all selected options', scope, state: {},
  searchDecision: { ...searchDecision, search: { ...searchDecision.search, preferredRecordIds: [] } },
  verifiedEvidence: sixOperands, requestedEntityRecordIds: sixOperands.map((entry) => entry.recordId),
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  invokeStructuredLlm: async ({ messages }) => {
    assert.ok(messages[0].content.includes('E6'), 'The answer LLM must receive every required operand');
    return { outputParsed: { decision: 'RESPONSE', response: 'Each selected option costs 3200 units.',
      clarification: null, evidenceIds: sixOperands.map((_, index) => `E${index + 1}`),
      nextQuestion: null, stateUpdate: null } };
  },
});
assert.equal(completeComparison.decision.evidenceIds.length, 6);
const numericRepair = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, scope,
  verifiedEvidence: [{ ...verifiedEvidence[0], content: 'Published pricing is available.',
    authoritativeData: { price: 3200, metadata: { revision: 9900 } } }],
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  invokeStructuredLlm: async (request) => {
    numericRepairCalls += 1;
    if (numericRepairCalls === 2) {
      const instruction = request.messages.at(-1).content;
      assert.ok(instruction.includes('Numeric validation feedback:'));
      assert.ok(instruction.includes('9900'));
      assert.ok(instruction.includes('checkedEvidenceAliases'));
      assert.ok(instruction.includes('E1'));
      assert.ok(!instruction.includes('evidence-1'), 'Repair feedback uses aliases, not runtime IDs');
    }
    return { outputParsed: {
      decision: 'RESPONSE', response: numericRepairCalls === 1
        ? 'The price is 9900 units.' : 'The price is 3,200.00 units.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(numericRepairCalls, 2);
assert.equal(numericRepair.decision.response, 'The price is 3,200.00 units.');

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
    return { supported: true, requestedFactAddressed: true };
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

let entityBoundRequest;
const entityBound = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision,
  requestedEntityRecordIds: ['record-1'],
  verifiedEvidence: [verifiedEvidence[0], {
    ...verifiedEvidence[0], evidenceId: 'unrelated-evidence', recordId: 'unrelated-record',
    canonicalName: 'Unrelated Service', content: 'An unrelated published value is 9999.',
  }],
  scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  invokeStructuredLlm: async (request) => {
    entityBoundRequest = request;
    return { outputParsed: {
      decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.deepEqual(entityBound.input.requestedEntityRecordIds, ['record-1']);
assert.equal(entityBound.input.verifiedEvidence.length, 1,
  'Post-search generation must receive only evidence for the resolved entity');
assert.doesNotMatch(entityBoundRequest.messages[0].content, /Unrelated Service|9999/u);
assert.deepEqual(entityBoundRequest.responseFormat.schema.properties.evidenceIds.items.enum, ['E1']);

let completeEvidenceValidation;
const completeEvidenceResult = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state: { ...state, lastReferencedRecordIds: [] },
  searchDecision: {
    ...searchDecision,
    search: { ...searchDecision.search, preferredRecordIds: [] },
  },
  verifiedEvidence: [verifiedEvidence[0], {
    ...verifiedEvidence[0], evidenceId: 'evidence-complete-2', recordId: 'record-complete-2',
    canonicalName: 'Second Service', content: 'A second verified record.',
  }],
  scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async (input) => {
    completeEvidenceValidation = input;
    return { supported: true, requestedFactAddressed: true };
  },
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
    clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
  } }),
});
assert.equal(completeEvidenceResult.decision.decision, 'RESPONSE');
assert.equal(completeEvidenceValidation.selectedEvidence.length, 2,
  'Claim validation must receive the complete hydrated evidence set');
assert.equal(completeEvidenceValidation.citedEvidence.length, 1,
  'Citation validation must retain the exact cited evidence subset');

let relevanceCalls = 0;
const relevanceFacts = [];
let relevanceDiagnostics;
const relevantAnswer = await respondToTemplateEngineSearch({
  mainPrompt,
  latestUtterance: 'Which included feature does it have?',
  state,
  searchDecision: {
    ...searchDecision,
    search: {
      ...searchDecision.search,
      query: 'selected service included feature',
      requestedFact: 'included feature',
    },
  },
  verifiedEvidence: [{
    ...verifiedEvidence[0],
    content: 'The selected service costs 3200 currency units and includes feature Delta.',
  }],
  scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async (input) => {
    relevanceFacts.push(input.searchInterpretation.requestedFact);
    return {
      supported: true,
      requestedFactAddressed: input.response.includes('feature Delta'),
      reason: input.response.includes('feature Delta') ? null : 'requested_fact_not_addressed',
    };
  },
  invokeStructuredLlm: async () => {
    relevanceCalls += 1;
    return { outputParsed: {
      decision: 'RESPONSE',
      response: relevanceCalls === 1
        ? 'The selected service costs 3200 currency units.'
        : 'The selected service includes feature Delta.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
  onPostSearchDiagnostics: (details) => { relevanceDiagnostics = details; },
});
assert.equal(relevanceCalls, 2,
  'A grounded but incomplete answer must receive exactly one repair attempt');
assert.equal(relevantAnswer.decision.response,
  'The selected service includes feature Delta.');
assert.deepEqual(relevanceFacts, ['included feature', 'included feature']);
assert.equal(relevanceDiagnostics.initialValidationReason, 'requested_fact_not_addressed');
assert.equal(relevanceDiagnostics.repairAttempted, true);
assert.equal(relevanceDiagnostics.finalDecision, 'RESPONSE');

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
for (const comparisonUtterance of [
  'Compare the first and second services.', 'Yes, compare both.', 'ஆமாம்', 'aama compare pannunga',
]) {
const comparisonResult = await respondToTemplateEngineSearch({
  mainPrompt,
  latestUtterance: comparisonUtterance,
  state: {
    ...state,
    pendingClarification: { question: 'Compare the first and second services?',
      reason: 'confirm comparison', candidates: ['First Service', 'Second Service'] },
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
  ambiguity: { required: true, kind: 'published_entity_candidates',
    candidates: ['First Service', 'Second Service'] },
  publishedEntities: [
    { recordId: 'record-1', canonicalName: 'First Service' },
    { recordId: 'record-2', canonicalName: 'Second Service' },
  ],
  validateGroundedClaims: async (input) => {
    comparisonClaimInput = input;
    return { supported: true, requestedFactAddressed: true };
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
}

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
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
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
const groundedRecovery = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async (input) => {
    groundedValidationCalls += 1;
    return groundedValidationCalls === 1
      ? { supported: false, requestedFactAddressed: false, reason: 'attribute_not_supported' }
      : { supported: true, requestedFactAddressed: true, reason: null };
  },
  invokeStructuredLlm: async () => {
    groundedRepairCalls += 1;
    return groundedRepairCalls === 1 ? { outputParsed: {
      decision: 'RESPONSE', response: 'The service includes an unpublished attribute.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } } : { outputParsed: {
      decision: 'RESPONSE', response: 'The current price is 3200 currency units.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(groundedRepairCalls, 2,
  'An unsupported grounded response must receive exactly one repair attempt');
assert.equal(groundedValidationCalls, 2,
  'Both the original and repaired factual responses must be grounded');
assert.equal(groundedRecovery.decision.decision, 'RESPONSE');

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
    requestedFactAddressed: decision === 'NO_MATCH',
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
  mainPrompt, latestUtterance: 'Which selected service?',
  state: { ...state, lastReferencedRecordIds: [] },
  searchDecision: {
    ...searchDecision,
    search: {
      query: 'selected service', requestedFact: 'service identity',
      contextualReference: null, preferredRecordIds: [],
    },
  },
  verifiedEvidence: [verifiedEvidence[0], secondEvidence], scope,
}, {
  tenantBoundaryVerified: true,
  ambiguity: { required: true, kind: 'entity', candidates: ['First Service', 'Second Service'] },
  validateGroundedClaims: async (input) => {
    clarificationValidationInput = input;
    return { supported: true, requestedFactAddressed: true, reason: null };
  },
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'CLARIFY', response: '', clarification: {
      question: 'Do you mean First Service or Second Service?',
      reason: 'ambiguous reference', candidates: ['First Service', 'Second Service'],
    }, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  } }),
});
assert.equal(groundedClarification.decision.decision, 'CLARIFY');
assert.equal(clarificationValidationInput.decision, 'CLARIFY');
assert.equal(clarificationValidationInput.selectedEvidence.length, 2,
  'Clarification speech validation receives the complete verified evidence set');

let ambiguityRepairCalls = 0;
const repairedAmbiguity = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance: 'Which selected service?',
  state: { ...state, lastReferencedRecordIds: [] },
  searchDecision: {
    ...searchDecision,
    search: {
      query: 'selected service', requestedFact: 'service identity',
      contextualReference: null, preferredRecordIds: [],
    },
  },
  verifiedEvidence: [verifiedEvidence[0], secondEvidence], scope,
}, {
  tenantBoundaryVerified: true,
  ambiguity: {
    required: true, kind: 'entity', candidates: ['First Service', 'Second Service'],
  },
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  invokeStructuredLlm: async (request) => {
    ambiguityRepairCalls += 1;
    if (ambiguityRepairCalls === 1) return { outputParsed: {
      decision: 'RESPONSE', response: 'The selected service has published information.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
    assert.deepEqual(request.responseFormat.schema.properties.decision.enum, ['CLARIFY']);
    return { outputParsed: {
      decision: 'CLARIFY', response: '', clarification: {
        question: 'Do you mean First Service or Second Service?',
        reason: 'Two published candidates remain',
        candidates: ['First Service', 'Second Service'],
      }, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(ambiguityRepairCalls, 2);
assert.equal(repairedAmbiguity.decision.decision, 'CLARIFY',
  'A genuine ambiguity validation failure must become CLARIFY, not an operational error');

let contextualRepairCalls = 0;
const resolvedContext = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance: 'What does it include?', state,
  searchDecision: {
    ...searchDecision,
    search: {
      query: 'selected service included features', requestedFact: 'included features',
      contextualReference: 'selected service', preferredRecordIds: ['record-1'],
    },
  },
  verifiedEvidence, scope,
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({
    supported: true, requestedFactAddressed: true, reason: null,
  }),
  invokeStructuredLlm: async () => {
    contextualRepairCalls += 1;
    return { outputParsed: contextualRepairCalls === 1 ? {
      decision: 'CLARIFY', response: '', clarification: {
        question: 'Which service do you mean?', reason: 'ambiguous reference',
        candidates: ['First Service', 'Second Service'],
      }, evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } : {
      decision: 'RESPONSE', response: 'The selected service includes the published features.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(contextualRepairCalls, 2,
  'A false clarification for one cited record must be repaired once');
assert.equal(resolvedContext.decision.decision, 'RESPONSE');
assert.deepEqual(resolvedContext.decision.evidenceIds, ['evidence-1']);

let fallbackCalls = 0;
let fallbackDiagnostics;
let extractiveValidationCalls = 0;
const deterministicFallback = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async ({ response, citedEvidence }) => {
    extractiveValidationCalls += 1;
    assert.equal(response, verifiedEvidence[0].content);
    assert.deepEqual(citedEvidence.map((entry) => entry.evidenceId), ['evidence-1']);
    return { supported: true, requestedFactAddressed: true };
  },
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
});
assert.equal(fallbackCalls, 2);
assert.equal(extractiveValidationCalls, 1, 'Extracted recovery must not bypass claim validation');
assert.equal(fallbackDiagnostics.recovered, true);
assert.equal(fallbackDiagnostics.configuredFallbackApplied, false);
assert.equal(fallbackDiagnostics.extractiveRecoveryApplied, true);
assert.equal(fallbackDiagnostics.first.responsePresent, true);
assert.equal(fallbackDiagnostics.first.evidenceIdCount, 0);
assert.equal(deterministicFallback.decision.decision, 'RESPONSE',
  'Answerable evidence must recover to RESPONSE without an operational failure');
assert.deepEqual(deterministicFallback.decision.evidenceIds, ['evidence-1']);

let changedDecisionCalls = 0;
const changedDecisionRecovery = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({
    supported: true, requestedFactAddressed: true,
  }),
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
});
assert.equal(changedDecisionCalls, 2);
assert.equal(changedDecisionRecovery.decision.decision, 'RESPONSE',
  'A citation repair must never convert answerable evidence into NO_MATCH');
assert.deepEqual(changedDecisionRecovery.decision.evidenceIds, ['evidence-1']);
assert.equal(changedDecisionRecovery.diagnostics.extractiveRecoveryApplied, true);

let malformedRepairCalls = 0;
let malformedRepairDiagnostics;
const malformedRepair = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence, scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
  invokeStructuredLlm: async () => {
    malformedRepairCalls += 1;
    return malformedRepairCalls === 1 ? { outputParsed: {
      decision: 'RESPONSE', response: 'A supported answer.', clarification: null,
      evidenceIds: [], nextQuestion: null, stateUpdate: null,
    } } : { outputParsed: {
      decision: 'RESPONSE', response: 'The selected service costs 3200 currency units.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
  onDecisionRepair: (details) => { malformedRepairDiagnostics = details; },
});
assert.equal(malformedRepairCalls, 2);
assert.equal(malformedRepair.decision.decision, 'RESPONSE');
assert.deepEqual(malformedRepair.decision.evidenceIds, ['evidence-1']);
assert.equal(malformedRepairDiagnostics.recovered, true);
assert.equal(malformedRepairDiagnostics.configuredFallbackApplied, false);

for (const [tenantId, languageText] of [
  ['tenant-a', 'விவரங்களை சொல்லுங்கள்'],
  ['tenant-a', 'details sollunga'],
  ['tenant-b', 'Please provide the details'],
]) {
  const scopedEvidenceId = `evidence-${tenantId}`;
  const scopedRecordId = `record-${tenantId}`;
  const scopedScope = Object.freeze({
    tenantId, agentId: `agent-${tenantId}`,
    publications: Object.freeze([Object.freeze({
      knowledgeBaseId: `kb-${tenantId}`, publicationRevision: 1,
    })]),
  });
  const scopedState = Object.freeze({
    ...state, lastReferencedRecordIds: Object.freeze([scopedRecordId]),
  });
  const scopedSearch = Object.freeze({
    ...searchDecision,
    search: Object.freeze({
      query: languageText, requestedFact: 'details',
      contextualReference: 'Configured Service', preferredRecordIds: [scopedRecordId],
    }),
  });
  const scopedEvidence = Object.freeze([Object.freeze({
    verified: true, callerFacing: true, evidenceId: scopedEvidenceId,
    recordId: scopedRecordId, recordType: 'CATALOG_ITEM', tenantId,
    agentId: scopedScope.agentId, knowledgeBaseId: `kb-${tenantId}`,
    publicationRevision: 1, canonicalName: 'Configured Service',
    content: 'Configured Service has the published detail Delta.',
    publishedAttributePaths: Object.freeze(['details']),
  })]);
  let attempts = 0;
  const recovered = await respondToTemplateEngineSearch({
    mainPrompt, latestUtterance: languageText, state: scopedState,
    searchDecision: scopedSearch, verifiedEvidence: scopedEvidence, scope: scopedScope,
    informationUnavailableResponse: 'Published information is unavailable.',
  }, {
    tenantBoundaryVerified: true,
    validateGroundedClaims: async () => ({ supported: true, requestedFactAddressed: true }),
    invokeStructuredLlm: async () => {
      attempts += 1;
      return { outputParsed: attempts === 1 ? {
        decision: 'RESPONSE', response: 'Incomplete citation payload.',
        clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
      } : {
        decision: 'RESPONSE', response: 'The published detail is Delta.',
        clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
      } };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(recovered.decision.decision, 'RESPONSE',
    'Answerable malformed output must recover to RESPONSE, never NO_MATCH');
  assert.deepEqual(recovered.decision.evidenceIds, [scopedEvidenceId]);
}

let rejectedAttempts = 0;
let originalEvidenceMessage;
await assert.rejects(respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, scope, verifiedEvidence,
  searchDecision: { ...searchDecision, search: {
    ...searchDecision.search, requestedFact: 'unmapped_attribute',
  } },
  informationUnavailableResponse: 'Published information is unavailable.',
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async ({ messages }) => {
    rejectedAttempts += 1;
    if (rejectedAttempts === 1) originalEvidenceMessage = messages[0].content;
    else assert.equal(messages[0].content, originalEvidenceMessage,
      'Repair must preserve the original evidence and aliases');
    return { outputParsed: { decision: 'RESPONSE', response: 'Invalid uncited output.',
      evidenceIds: [], clarification: null, nextQuestion: null, stateUpdate: null } };
  },
}), (error) => classifyTemplateEngineTurnError(error) === 'validation');
assert.equal(rejectedAttempts, 2,
  'Validation rejection must repair once, not infer NO_MATCH from a failed fact-token match');

const emptyEvidenceFallback = await respondToTemplateEngineSearch({
  mainPrompt, latestUtterance, state, searchDecision, verifiedEvidence: [], scope,
  informationUnavailableResponse: 'That information is not available right now.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async ({ decision, response }) => ({
    supported: decision === 'NO_MATCH'
      && response === 'That information is not available right now.',
    requestedFactAddressed: decision === 'NO_MATCH',
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
