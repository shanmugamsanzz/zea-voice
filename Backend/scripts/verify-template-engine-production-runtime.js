import assert from 'node:assert/strict';
import { retrieveTemplateEngineEvidence } from '../src/voice/interaction/template-engine-production-retrieval.js';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const publication = { knowledgeBaseId, publicationRevision: 4 };
const scope = { tenantId, agentId, publications: [publication] };
const searchDecision = {
  decision: 'SEARCH', response: '', clarification: null,
  search: { query: 'tenant item price', requestedFact: 'price', contextualReference: 'tenant item', preferredRecordIds: [] },
  tool: null, stateUpdate: null,
};
let channelCalls = 0;
const candidate = {
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId: 'record-1', recordType: 'CATALOG_ITEM', score: 0.9,
};
const retrieval = await retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-1', usageDirection: 'inbound',
  language: 'ta', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => {
    channelCalls += 1;
    return { channels: { structured: [candidate], bm25: [candidate], qdrant: [candidate] } };
  },
  hydrateEvidence: async ({ retrieval: selected }) => {
    assert.equal(selected.candidates.length, 1);
    return { evidence: [{
      ...candidate, id: 'evidence-1', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: 'Tenant Item costs 125.', authoritativeData: { name: 'Tenant Item', price: 125 },
      provenance: { knowledgeBaseId, publicationRevision: 4 },
    }] };
  },
});
assert.equal(channelCalls, 1);
assert.equal(retrieval.evidence.length, 1);
assert.equal(retrieval.evidence[0].verified, true);

const decisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['evidence-1'], stateUpdate: null,
}];
const turn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-1', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Answer in English. Search for factual requests.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => decisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
  retrieveEvidence: async () => retrieval,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(turn.speech, 'Tenant Item costs 125.');
assert.deepEqual(turn.evidenceIds, ['evidence-1']);
assert.deepEqual(turn.state.lastReferencedRecordIds, ['record-1']);
assert.equal(decisions.length, 0);

const tool = {
  id: 'tool-1', name: 'perform_action', status: 'active', type: 'webhook_api',
  configuration: {
    identifier: 'perform_action',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { contact_name: { type: 'string', minLength: 1 } },
      required: ['contact_name'],
      'x-confirmation-message': 'Confirm these details?',
    },
  },
};
const workflow = {
  recordId: 'workflow-1', recordType: 'WORKFLOW_RULE', tenantId, agentId,
  knowledgeBaseId, publicationRevision: 4, published: true, status: 'published',
  actionType: 'configured_tool', actionConfig: { toolIdentifier: 'perform_action' },
};
const workflowDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} }, stateUpdate: null,
}, { speech: 'Please provide the configured contact name.' }];
const workflowTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-2', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Please perform the action.', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => workflowDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('incomplete workflow must not execute'); },
  validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(workflowTurn.workflow.status, 'AWAITING_FIELD');
assert.equal(workflowTurn.state.activeWorkflowId, 'workflow-1');
assert.equal(workflowTurn.toolExecuted, false);
assert.equal(workflowDecisions.length, 0);

const confirmationDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} },
  stateUpdate: { set: { confirmationStatus: 'confirmed' }, clear: [] },
}, { speech: 'The action completed successfully.' }];
let executed = 0;
const confirmedTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-2', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Yes, confirm it.', conversationHistory: [],
  state: {
    activeWorkflowId: 'workflow-1', collectedToolFields: { contact_name: 'Sam' },
    confirmationStatus: 'awaiting_confirmation',
  },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => confirmationDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {
    executed += 1;
    return { verified: true, success: true, output: { success: true } };
  },
  validateGroundedClaims: async () => ({ supported: true, successClaimed: false }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: true }),
});
assert.equal(executed, 1);
assert.equal(confirmedTurn.workflow.status, 'SUCCEEDED');
assert.equal(confirmedTurn.state.activeWorkflowId, null);
assert.equal(confirmationDecisions.length, 0);

console.log('Template-engine production retrieval and turn runtime verification passed.');
