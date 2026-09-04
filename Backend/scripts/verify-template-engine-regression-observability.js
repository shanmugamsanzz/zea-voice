import assert from 'node:assert/strict';
import {
  respondToTemplateEngineSearch,
  routeTemplateEngineUtterance,
} from '../src/voice/interaction/template-engine-orchestrator.js';

const publication = (knowledgeBaseId) => ({ knowledgeBaseId, publicationRevision: 3 });
const configurations = Object.freeze([
  Object.freeze({
    tenantId: 'tenant-one', agentId: 'agent-one', knowledgeBaseId: 'kb-one',
    language: 'en', acknowledgement: 'Hello, thank you.',
    acknowledgementResponse: 'Hello! You are welcome.',
    factualQuestion: 'What is the current service price?',
    followUp: 'What is its price?', response: 'The current price is 125 units.',
  }),
  Object.freeze({
    tenantId: 'tenant-two', agentId: 'agent-two', knowledgeBaseId: 'kb-two',
    language: 'ta', acknowledgement: 'சரிங்க, நன்றி.',
    acknowledgementResponse: 'சரிங்க, சொல்லுங்க.',
    factualQuestion: 'இந்த சேவையின் தற்போதைய விலை என்ன?',
    followUp: 'இதோட விலை என்ன?', response: 'தற்போதைய விலை 125 ரூபாய்.',
  }),
]);

function fixture(configuration) {
  const recordId = `record-${configuration.tenantId}`;
  const evidenceId = `evidence-${configuration.tenantId}`;
  const scope = Object.freeze({
    tenantId: configuration.tenantId,
    agentId: configuration.agentId,
    publications: Object.freeze([publication(configuration.knowledgeBaseId)]),
  });
  const state = Object.freeze({
    recentCompleteTurns: Object.freeze([
      Object.freeze({ role: 'user', content: configuration.factualQuestion }),
      Object.freeze({ role: 'assistant', content: configuration.response }),
    ]),
    lastReferencedRecordIds: Object.freeze([recordId]),
    comparisonRecordIds: Object.freeze([]), pendingClarification: null,
    activeWorkflowId: null, collectedToolFields: Object.freeze({}), confirmationStatus: null,
  });
  const evidence = Object.freeze([Object.freeze({
    verified: true, callerFacing: true, evidenceId, recordId,
    recordType: 'CATALOG_ITEM', tenantId: configuration.tenantId,
    agentId: configuration.agentId, knowledgeBaseId: configuration.knowledgeBaseId,
    publicationRevision: 3, content: 'The current verified value is 125 units.',
  })]);
  return { recordId, evidenceId, scope, state, evidence };
}

for (const configuration of configurations) {
  const current = fixture(configuration);
  const acknowledgement = await routeTemplateEngineUtterance({
    mainPrompt: `Use ${configuration.language} and answer non-factual acknowledgements directly.`,
    latestUtterance: configuration.acknowledgement,
  }, {
    tenantBoundaryVerified: true,
    nonFactualResponseAllowed: true,
    invokeStructuredLlm: async () => ({
      decision: 'RESPONSE', response: configuration.acknowledgementResponse,
      clarification: null, search: null, tool: null, nextQuestion: null, stateUpdate: null,
    }),
  });
  assert.equal(acknowledgement.decision.decision, 'RESPONSE');
  assert.equal(acknowledgement.outputValidation.ttsAllowed, true);

  const searchDecision = {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: `${configuration.factualQuestion} current value`, requestedFact: 'current value',
      contextualReference: 'previously referenced service',
      preferredRecordIds: [current.recordId],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  };
  const routed = await routeTemplateEngineUtterance({
    mainPrompt: 'Search for every externally verifiable fact.',
    latestUtterance: configuration.followUp,
    conversationHistory: current.state.recentCompleteTurns,
    lastReferencedRecordIds: current.state.lastReferencedRecordIds,
  }, {
    tenantBoundaryVerified: true,
    invokeStructuredLlm: async () => searchDecision,
  });
  assert.equal(routed.decision.decision, 'SEARCH');
  assert.deepEqual(routed.decision.search.preferredRecordIds, [current.recordId]);

  let diagnostics;
  let providerCalls = 0;
  const grounded = await respondToTemplateEngineSearch({
    mainPrompt: 'Answer facts only from supplied evidence.',
    latestUtterance: configuration.followUp,
    state: current.state, searchDecision, verifiedEvidence: current.evidence,
    scope: current.scope,
  }, {
    tenantBoundaryVerified: true,
    validateGroundedClaims: async () => ({ supported: true }),
    onPostSearchDiagnostics: (value) => { diagnostics = value; },
    invokeStructuredLlm: async () => {
      providerCalls += 1;
      return { outputParsed: {
        decision: 'RESPONSE', response: configuration.response,
        clarification: null,
        evidenceIds: providerCalls === 1 ? ['invalid-internal-id'] : ['E1'],
        nextQuestion: null,
        stateUpdate: null,
      } };
    },
  });
  assert.equal(grounded.decision.decision, 'RESPONSE');
  assert.deepEqual(grounded.decision.evidenceIds, [current.evidenceId]);
  assert.equal(providerCalls, 2);
  assert.deepEqual(diagnostics.allowedAliases, ['E1']);
  assert.deepEqual(diagnostics.returnedAliases, ['E1']);
  assert.equal(diagnostics.initialValidationReason, 'unknown_evidence_id');
  assert.equal(diagnostics.validationReason, null);
  assert.equal(diagnostics.finalDecision, 'RESPONSE');
}

const first = fixture(configurations[0]);
const second = fixture(configurations[1]);
await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt: 'Use only tenant-scoped evidence.',
  latestUtterance: configurations[0].factualQuestion,
  state: first.state,
  searchDecision: {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: 'current value', requestedFact: 'current value', contextualReference: null,
      preferredRecordIds: [],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  },
  verifiedEvidence: second.evidence,
  scope: first.scope,
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => { throw new Error('cross-tenant evidence reached provider'); },
}), (error) => error.code === 'TEMPLATE_ENGINE_POST_SEARCH_SCOPE_VIOLATION');

const noEvidence = await respondToTemplateEngineSearch({
  mainPrompt: 'Use a natural unavailable response when evidence cannot answer.',
  latestUtterance: 'Is an unpublished value available?', state: first.state,
  searchDecision: {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: 'unpublished value', requestedFact: 'value', contextualReference: null,
      preferredRecordIds: [],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  },
  verifiedEvidence: [], scope: first.scope,
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => ({ outputParsed: {
    decision: 'NO_MATCH', response: 'That information is not published.',
    clarification: null, evidenceIds: [], nextQuestion: null, stateUpdate: null,
  } }),
});
assert.equal(noEvidence.decision.decision, 'NO_MATCH');

let hallucinationRepairCalls = 0;
const hallucinationBlocked = await respondToTemplateEngineSearch({
  mainPrompt: 'Answer facts only from supplied evidence.',
  latestUtterance: configurations[0].factualQuestion, state: first.state,
  searchDecision: {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: 'current value', requestedFact: 'current value', contextualReference: null,
      preferredRecordIds: [first.recordId],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  },
  verifiedEvidence: first.evidence, scope: first.scope,
  informationUnavailableResponse: 'That information is not published.',
}, {
  tenantBoundaryVerified: true,
  validateGroundedClaims: async () => ({ supported: true }),
  invokeStructuredLlm: async () => {
    hallucinationRepairCalls += 1;
    return { outputParsed: {
      decision: 'RESPONSE', response: 'The current value is 9999 units.',
      clarification: null, evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
    } };
  },
});
assert.equal(hallucinationRepairCalls, 2);
assert.equal(hallucinationBlocked.decision.decision, 'NO_MATCH');
assert.equal(hallucinationBlocked.outputValidation.ttsAllowed, true);
assert.equal(hallucinationBlocked.outputValidation.valid, true);

const providerFailure = new Error('provider unavailable');
await assert.rejects(() => respondToTemplateEngineSearch({
  mainPrompt: 'Answer facts only from supplied evidence.',
  latestUtterance: configurations[0].factualQuestion, state: first.state,
  searchDecision: {
    decision: 'SEARCH', response: '', clarification: null,
    search: {
      query: 'current value', requestedFact: 'current value', contextualReference: null,
      preferredRecordIds: [],
    },
    tool: null, nextQuestion: null, stateUpdate: null,
  },
  verifiedEvidence: first.evidence, scope: first.scope,
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => { throw providerFailure; },
}), (error) => error === providerFailure);

console.log('Template-engine multi-tenant regression and observability verification passed.');
