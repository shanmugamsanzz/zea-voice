import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTemplateEngineOrchestratorInput,
  routeTemplateEngineUtterance,
} from '../src/voice/interaction/template-engine-orchestrator.js';

const history = [];
for (let index = 1; index <= 6; index += 1) {
  history.push({ role: 'user', content: `caller turn ${index}` });
  history.push({ role: 'assistant', content: `agent turn ${index}` });
}
history.push({ role: 'user', content: 'incomplete caller turn' });

const normalized = createTemplateEngineOrchestratorInput({
  mainPrompt: 'Use SEARCH for tenant facts and RESPONSE for greetings.',
  latestUtterance: 'What information is available?',
  conversationHistory: history,
  pendingClarification: { question: 'Which option?', candidates: ['A', 'B'] },
  activeWorkflowState: {
    status: 'collecting', authorizationRecordId: 'workflow-1', internalEndpoint: 'hidden',
    workflowState: {
      toolIdentifier: 'configured_action', requiredFields: ['field_a', 'field_b'],
      missingFields: ['field_b'], collectedFields: { field_a: 'value' },
      confirmationRequired: true, confirmationStatus: 'pending_fields',
    },
  },
  citedRecordReferences: [
    { recordId: 'record-1', recordType: 'ITEM', sourceId: 'source-1' },
    { recordId: 'record-1', recordType: 'ITEM', sourceId: 'source-1' },
  ],
  authorizedWorkflowTools: [{
    workflowRecordId: 'workflow-1', name: 'configured_action',
    description: 'Perform the configured action',
    inputSchema: { required: ['field_a', 'field_b'] },
  }],
});
assert.equal(normalized.state.recentCompleteTurns.length, 10);
assert.equal(normalized.state.recentCompleteTurns[0].content, 'caller turn 2');
assert.equal(normalized.state.recentCompleteTurns.at(-1).content, 'agent turn 6');
assert.equal(normalized.state.recentCompleteTurns
  .some((turn) => turn.content.includes('incomplete')), false);
assert.deepEqual(normalized.state.lastReferencedRecordIds, ['record-1']);
assert.deepEqual(normalized.authorizedWorkflowTools[0].requiredFields, ['field_a', 'field_b']);
assert.equal(normalized.state.activeWorkflowId, 'workflow-1');
assert.equal(Object.hasOwn(normalized.state, 'internalEndpoint'), false);

let invocations = 0;
let providerRequest = null;
const routed = await routeTemplateEngineUtterance({
  ...normalized,
  conversationHistory: normalized.state.recentCompleteTurns,
  lastReferencedRecordIds: normalized.state.lastReferencedRecordIds,
  pendingClarification: normalized.state.pendingClarification,
  activeWorkflowId: normalized.state.activeWorkflowId,
  collectedToolFields: normalized.state.collectedToolFields,
  confirmationStatus: normalized.state.confirmationStatus,
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async (request) => {
    invocations += 1;
    providerRequest = request;
    return {
      outputParsed: {
        decision: 'SEARCH', response: '', clarification: null,
        search: {
          query: 'available information', requestedFact: 'available information',
          contextualReference: null,
        },
        tool: null, nextQuestion: null, stateUpdate: null,
      },
    };
  },
});
assert.equal(invocations, 1);
assert.equal(routed.decision.decision, 'SEARCH');
assert.equal(providerRequest.temperature, 0);
assert.equal(providerRequest.responseFormat.strict, true);
assert.equal(providerRequest.responseFormat.schema.additionalProperties, false);
assert.equal(providerRequest.messages.length, 2);
assert.match(providerRequest.messages[0].content, /<tenant_main_prompt_json>/u);
assert.match(providerRequest.messages[0].content, /<orchestrator_turn_input>/u);
assert.doesNotMatch(providerRequest.messages[0].content, /incomplete caller turn/u);
assert.doesNotMatch(providerRequest.messages[0].content, /currentTopic|knownEntities/u);

let socialRequest;
const socialTurn = await routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for non-factual social conversation and SEARCH for facts.',
  latestUtterance: 'Hello, thank you.',
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  invokeStructuredLlm: async (request) => {
    socialRequest = request;
    return {
      decision: 'RESPONSE', response: 'Hello! You are welcome.', clarification: null,
      search: null, tool: null,
      nextQuestion: { question: 'How may I help?', reason: 'conversation_guidance' },
      stateUpdate: null,
    };
  },
});
assert.equal(socialTurn.decision.decision, 'RESPONSE');
assert.equal(socialTurn.decision.nextQuestion.question, 'How may I help?');
assert.equal(socialTurn.outputValidation.route, 'TTS');
assert.match(socialRequest.messages[0].content,
  /Conversational interaction management includes greetings/u);

let reviewedCalls = 0;
const reviewedSocialTurn = await routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for non-factual conversation and SEARCH for factual requests.',
  latestUtterance: 'Okay, please continue.',
  lastReferencedRecordIds: ['record-from-prior-factual-turn'],
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  invokeStructuredLlm: async () => {
    reviewedCalls += 1;
    return reviewedCalls === 1 ? {
      decision: 'SEARCH', response: '', clarification: null,
      search: {
        query: 'continue', requestedFact: null, contextualReference: null,
        preferredRecordIds: [],
      },
      tool: null, nextQuestion: null, stateUpdate: null,
    } : {
      decision: 'RESPONSE', response: 'Certainly, please continue.', clarification: null,
      search: null, tool: null, nextQuestion: null, stateUpdate: null,
    };
  },
});
assert.equal(reviewedCalls, 2);
assert.equal(reviewedSocialTurn.routingReviewAttempted, true);
assert.equal(reviewedSocialTurn.decision.decision, 'RESPONSE');

for (const interaction of [
  ['Please wait for a moment.', 'Certainly, take your time.'],
  ['Are you still present?', 'Yes, I am here.'],
  ['Thanks, I understand.', 'You are welcome.'],
]) {
  const routedInteraction = await routeTemplateEngineUtterance({
    mainPrompt: 'Respond naturally to non-factual conversation management and search for facts.',
    latestUtterance: interaction[0],
    conversationHistory: [
      { role: 'user', content: 'Tell me the published value.' },
      { role: 'assistant', content: 'The published value is 10.' },
    ],
    lastReferencedRecordIds: ['record-from-prior-factual-turn'],
  }, {
    tenantBoundaryVerified: true,
    nonFactualResponseAllowed: true,
    invokeStructuredLlm: async () => ({
      decision: 'RESPONSE', response: interaction[1], clarification: null,
      search: null, tool: null, nextQuestion: null, stateUpdate: null,
    }),
  });
  assert.equal(routedInteraction.decision.decision, 'RESPONSE');
  assert.equal(routedInteraction.outputValidation.route, 'TTS');
}

let factualReviewCalls = 0;
const reviewedFactualTurn = await routeTemplateEngineUtterance({
  mainPrompt: 'Respond to conversation management and search for externally verifiable facts.',
  latestUtterance: 'What options are currently available?',
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => {
    factualReviewCalls += 1;
    return factualReviewCalls === 1 ? {
      decision: 'SEARCH', response: '', clarification: null,
      search: {
        query: 'currently available options', requestedFact: null,
        contextualReference: null, preferredRecordIds: [],
      },
      tool: null, nextQuestion: null, stateUpdate: null,
    } : {
      decision: 'SEARCH', response: '', clarification: null,
      search: {
        query: 'currently available options', requestedFact: 'available options',
        contextualReference: null, preferredRecordIds: [],
      },
      tool: null, nextQuestion: null, stateUpdate: null,
    };
  },
});
assert.equal(factualReviewCalls, 2);
assert.equal(reviewedFactualTurn.routingReviewAttempted, true);
assert.equal(reviewedFactualTurn.decision.decision, 'SEARCH');
assert.equal(reviewedFactualTurn.decision.search.requestedFact, 'available options');

const ambiguousTurn = await routeTemplateEngineUtterance({
  mainPrompt: 'Clarify only genuine ambiguity.',
  latestUtterance: 'Tell me about that one.',
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  ambiguity: {
    required: true, kind: 'contextual_reference',
    candidates: ['Option Alpha', 'Option Beta'],
  },
  invokeStructuredLlm: async () => ({
    decision: 'CLARIFY', response: '', search: null, tool: null, nextQuestion: null, stateUpdate: null,
    clarification: {
      question: 'Do you mean Option Alpha or Option Beta?',
      reason: 'contextual_reference_ambiguous',
      candidates: ['Option Alpha', 'Option Beta'],
    },
  }),
});
assert.equal(ambiguousTurn.decision.decision, 'CLARIFY');
assert.equal(ambiguousTurn.outputValidation.route, 'TTS');

const resolvedContextSearch = await routeTemplateEngineUtterance({
  mainPrompt: 'Clarify only genuine ambiguity and search for factual details.',
  latestUtterance: 'What tests does it include?',
  lastReferencedRecordIds: ['diabetes-record'],
  conversationHistory: [
    { role: 'user', content: 'Explain the selected option.' },
    { role: 'assistant', content: 'Here is its grounded description.' },
  ],
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  ambiguity: { required: false, kind: 'resolved_context', candidates: [] },
  invokeStructuredLlm: async () => ({
    decision: 'CLARIFY', response: '', search: null, tool: null,
    clarification: {
      question: 'Which option do you mean?', reason: 'ambiguous reference',
      candidates: ['Only one option'],
    },
    nextQuestion: null, stateUpdate: null,
  }),
});
assert.equal(resolvedContextSearch.decision.decision, 'SEARCH');
assert.deepEqual(resolvedContextSearch.decision.search.preferredRecordIds, ['diabetes-record'],
  'A contextual factual follow-up must retain its one cited record instead of clarifying');
assert.equal(resolvedContextSearch.outputValidation.reason, 'clarification_not_required');

const recoveredDecision = {
  decision: 'RESPONSE', response: 'Certainly, we can continue.', clarification: null,
  search: null, tool: null, nextQuestion: null, stateUpdate: null,
};
for (const invalidOutput of [
  '',
  '{"decision":',
  { decision: 'RESPONSE' },
]) {
  const requests = [];
  let retryDetails = null;
  const recovered = await routeTemplateEngineUtterance({
    mainPrompt: 'Use RESPONSE for conversational acknowledgement and SEARCH for facts.',
    latestUtterance: 'Yes, please continue.',
    conversationHistory: [
      { role: 'user', content: 'May I continue?' },
      { role: 'assistant', content: 'Yes, please confirm.' },
    ],
  }, {
    tenantBoundaryVerified: true,
    nonFactualResponseAllowed: true,
    onDecisionRetry: (details) => { retryDetails = details; },
    invokeStructuredLlm: async (request) => {
      requests.push(request);
      return requests.length === 1 ? invalidOutput : recoveredDecision;
    },
  });
  assert.equal(requests.length, 2, 'Invalid decision must be retried exactly once');
  assert.equal(recovered.decision.decision, 'RESPONSE');
  assert.notEqual(recovered.decision.decision, 'NO_MATCH');
  assert.equal(recovered.decisionRepairAttempted, true);
  assert.equal(retryDetails.phase, 'initial_routing');
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length),
    requests[0].messages, 'Decision retry must preserve the complete caller turn envelope');
  assert.equal(requests[1].messages.at(-1).role, 'system');
}

let harmlessMixedCalls = 0;
const harmlessMixed = await routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for conversational acknowledgement and SEARCH for facts.',
  latestUtterance: 'Yes, please continue.',
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  invokeStructuredLlm: async () => {
    harmlessMixedCalls += 1;
    return {
      decision: 'response', response: 'Certainly.',
      clarification: { question: 'Inactive?', reason: null, candidates: [] },
      search: {
        query: 'inactive query', requestedFact: null,
        contextualReference: null, preferredRecordIds: [],
      },
      tool: { name: 'inactive_action', arguments: '{}' },
      nextQuestion: null, stateUpdate: null, providerAnnotation: 'ignored',
    };
  },
});
assert.equal(harmlessMixedCalls, 1,
  'Harmless inactive fields must be normalized without an LLM retry');
assert.equal(harmlessMixed.decision.decision, 'RESPONSE');
assert.equal(harmlessMixed.decision.response, 'Certainly.');
assert.equal(harmlessMixed.decision.search, null);
assert.equal(harmlessMixed.decision.tool, null);
assert.equal(harmlessMixed.decisionRepairAttempted, false);

let exhaustedDecisionAttempts = 0;
await assert.rejects(() => routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for conversational acknowledgement.',
  latestUtterance: 'Yes, please continue.',
}, {
  tenantBoundaryVerified: true,
  nonFactualResponseAllowed: true,
  invokeStructuredLlm: async () => {
    exhaustedDecisionAttempts += 1;
    return { decision: 'RESPONSE' };
  },
}), (error) => error.code === 'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID'
  && error.details?.reason === 'invalid_active_branch'
  && error.details?.attempts === 2);
assert.equal(exhaustedDecisionAttempts, 2);

const source = readFileSync(new URL(
  '../src/voice/interaction/template-engine-orchestrator.js', import.meta.url,
), 'utf8').toLocaleLowerCase();
for (const forbidden of ['hospital', 'package', 'crm', 'booking', 'appointment', 'patient']) {
  assert.equal(source.includes(forbidden), false, `Orchestrator contains domain vocabulary: ${forbidden}`);
}
for (const legacyDependency of ['intent-classifier', 'query-classifier', 'entity-route-resolver']) {
  assert.equal(source.includes(legacyDependency), false,
    `Orchestrator imports a parallel classifier: ${legacyDependency}`);
}

console.log('Template-engine Orchestrator verification passed.');
