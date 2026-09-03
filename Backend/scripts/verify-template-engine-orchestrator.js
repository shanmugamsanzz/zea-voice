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
        tool: null, stateUpdate: null,
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
      search: null, tool: null, stateUpdate: null,
    };
  },
});
assert.equal(socialTurn.decision.decision, 'RESPONSE');
assert.equal(socialTurn.outputValidation.route, 'TTS');
assert.match(socialRequest.messages[0].content,
  /purely social greeting, courtesy, acknowledgement/u);

let reviewedCalls = 0;
const reviewedSocialTurn = await routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for non-factual conversation and SEARCH for factual requests.',
  latestUtterance: 'Okay, please continue.',
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
      tool: null, stateUpdate: null,
    } : {
      decision: 'RESPONSE', response: 'Certainly, please continue.', clarification: null,
      search: null, tool: null, stateUpdate: null,
    };
  },
});
assert.equal(reviewedCalls, 2);
assert.equal(reviewedSocialTurn.routingReviewAttempted, true);
assert.equal(reviewedSocialTurn.decision.decision, 'RESPONSE');

await assert.rejects(() => routeTemplateEngineUtterance({
  mainPrompt: 'Use RESPONSE for greetings.',
  latestUtterance: 'Hello',
}, {
  tenantBoundaryVerified: true,
  invokeStructuredLlm: async () => ({
    decision: 'RESPONSE', response: 'Hello.', clarification: null,
    search: { query: 'not allowed', requestedFact: null, contextualReference: null },
    tool: null, stateUpdate: null,
  }),
}), (error) => error.code === 'TEMPLATE_ENGINE_ORCHESTRATOR_DECISION_INVALID'
  && error.details?.reason === 'mixed_decision_payload');

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
