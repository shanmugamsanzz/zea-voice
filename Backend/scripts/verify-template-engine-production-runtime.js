import assert from 'node:assert/strict';
import { retrieveTemplateEngineEvidence } from '../src/voice/interaction/template-engine-production-retrieval.js';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';
import { recordTemplateEngineTurnMetrics } from '../src/voice/interaction/template-engine-observability.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const knowledgeBaseId = '33333333-3333-4333-8333-333333333333';
const publication = { knowledgeBaseId, publicationRevision: 4 };
const scope = { tenantId, agentId, publications: [publication] };
const searchDecision = {
  decision: 'SEARCH', response: '', clarification: null,
  search: { query: 'tenant item price', requestedFact: 'price', contextualReference: 'tenant item', preferredRecordIds: [] },
  tool: null, nextQuestion: null, stateUpdate: null,
};
let channelCalls = 0;
const candidate = {
  tenantId, agentId, knowledgeBaseId, publicationRevision: 4,
  recordId: 'record-1', recordType: 'CATALOG_ITEM', score: 0.9,
  callerFacingHint: true, canonicalName: 'Tenant Item', searchForms: ['tenant item'],
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
  hydrateEvidence: async ({ retrieval: selected, requireAtLeastOneHydratedEvidence }) => {
    assert.equal(selected.candidates.length, 1);
    assert.equal(requireAtLeastOneHydratedEvidence, true);
    for (const channelCandidates of Object.values(selected.channels)) {
      assert.equal(channelCandidates[0].tenantId, tenantId);
      assert.equal(channelCandidates[0].agentId, agentId);
      assert.equal(channelCandidates[0].knowledgeBaseId, knowledgeBaseId);
      assert.equal(channelCandidates[0].publicationRevision, 4);
      assert.equal(channelCandidates[0].recordType, 'CATALOG_ITEM');
      assert.equal(channelCandidates[0].recordId, 'record-1');
    }
    return { evidence: [{
      ...candidate, id: 'evidence-1', hydrationValidated: true,
      publicationValidated: true, callerFacing: true,
      content: 'Tenant Item costs 125.', authoritativeData: {
        name: 'Tenant Item', price: 125,
        attributes: [{ key: 'published_detail', value: 'Approved value' }],
      },
      provenance: {
        knowledgeBaseId, publicationRevision: 4,
        documentId: 'document-1', documentVersionId: 'document-version-1',
        uploadedFilename: 'tenant-source.txt', documentDisplayName: 'Tenant Source',
        documentType: 'catalog', pageNumber: 1, pageEnd: 1,
        sourceSection: 'Approved values', sourceLineStart: 10, sourceLineEnd: 12,
      },
    }] };
  },
});
assert.equal(channelCalls, 1);
assert.equal(retrieval.evidence.length, 1);
assert.equal(retrieval.evidence[0].verified, true);
assert.equal(retrieval.evidence[0].documentName, 'tenant-source.txt');
assert.equal(retrieval.evidence[0].documentDisplayName, 'Tenant Source');
assert.equal(retrieval.evidence[0].pageNumber, 1);
assert.equal(retrieval.evidence[0].sourceLineStart, 10);
assert.equal(retrieval.evidence[0].sourceLineEnd, 12);
assert.equal(retrieval.evidence[0].requestedFact, 'price');
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('price'), true);
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('attributes.key'), true);
assert.equal(retrieval.evidence[0].publishedAttributePaths.includes('unpublished_detail'), false);
assert.deepEqual(retrieval.diagnostics.channelCounts, {
  structured: 1, bm25: 1, qdrant: 1,
});
assert.equal(retrieval.diagnostics.retrievalCount, 1);
assert.equal(retrieval.diagnostics.hydrationCount, 1);
assert.equal(retrieval.diagnostics.verifiedEvidenceCount, 1);
assert.equal(Number.isFinite(retrieval.diagnostics.durationMs), true);
assert.equal(retrieval.diagnostics.durationMs >= 0, true);

await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-empty', usageDirection: 'inbound',
  language: 'en', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => ({
    channels: { structured: [candidate], bm25: [candidate], qdrant: [candidate] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => ({
    evidence: [], fusion: { candidates: selected.candidates }, rejectedRecordIds: [],
  }),
}), (error) => error.code === 'TEMPLATE_ENGINE_AUTHORITATIVE_EVIDENCE_EMPTY'
  && error.details?.selectedCount === 1);

await assert.rejects(() => retrieveTemplateEngineEvidence({
  auth: { tenantId }, scope, callId: 'call-cross-scope', usageDirection: 'inbound',
  language: 'en', searchDecision, state: {},
}, {
  loadArtifacts: async () => ({ publications: [publication], bundles: [], sparseIndexes: [] }),
  searchCandidates: async () => ({
    channels: { structured: [candidate], bm25: [candidate], qdrant: [] },
  }),
  hydrateEvidence: async ({ retrieval: selected }) => ({
    fusion: { candidates: selected.candidates },
    evidence: [{
      ...candidate, tenantId: 'foreign-tenant', id: 'foreign-evidence',
      hydrationValidated: true, publicationValidated: true, callerFacing: true,
      content: 'Foreign content.', provenance: { knowledgeBaseId, publicationRevision: 4 },
    }],
  }),
}), (error) => error.code === 'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_VIOLATION'
  || error.code === 'TEMPLATE_ENGINE_HYDRATION_SCOPE_VIOLATION');

const decisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
}];
let retrievalDiagnostics;
let postSearchDiagnostics;
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
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onRetrievalDiagnostics: (details) => { retrievalDiagnostics = details; },
  onPostSearchDiagnostics: (details) => { postSearchDiagnostics = details; },
});
assert.equal(turn.speech, 'Tenant Item costs 125.');
assert.deepEqual(turn.evidenceIds, ['evidence-1']);
assert.deepEqual(turn.state.lastReferencedRecordIds, ['record-1']);
assert.equal(decisions.length, 0);
assert.equal(retrievalDiagnostics.retrievalCount, 1);
assert.deepEqual(postSearchDiagnostics.allowedAliases, ['E1']);
assert.deepEqual(postSearchDiagnostics.returnedAliases, ['E1']);
assert.equal(postSearchDiagnostics.finalDecision, 'RESPONSE');
assert.equal(turn.provenance.initialDecision, 'SEARCH');
assert.equal(turn.provenance.finalDecision, 'RESPONSE');
assert.deepEqual(turn.provenance.evidenceIds, ['evidence-1']);
assert.equal(turn.provenance.searchPerformed, true);

let speculativeStarted = false;
let routedWhileSpeculativeActive = false;
let ordinaryRetrievalCalls = 0;
let speculativeDiagnostics;
let deterministicChecks = 0;
const speculativeDecisions = [searchDecision, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: {
    question: 'Would you like another published detail?', reason: 'guidance',
  }, stateUpdate: null,
}];
const speculativeTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-speculative', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Answer in English. Search for factual requests.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => {
    routedWhileSpeculativeActive ||= speculativeStarted;
    return speculativeDecisions.shift();
  },
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [], artifacts: {},
    publishedConversationGuidance: [{
      recordId: 'guidance-1', purpose: 'Continue relevant assistance',
      nextQuestion: 'Would you like another published detail?',
    }],
  }),
  retrieveSpeculativeEvidence: async () => {
    speculativeStarted = true;
    return retrieval;
  },
  retrieveEvidence: async () => {
    ordinaryRetrievalCalls += 1;
    return retrieval;
  },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => {
    deterministicChecks += 1;
    return { supported: true, successClaimed: false, requestedFactAddressed: true };
  },
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
  onRetrievalDiagnostics: (details) => { speculativeDiagnostics = details; },
});
assert.equal(routedWhileSpeculativeActive, true,
  'Routing must run while speculative hybrid retrieval is already active');
assert.equal(ordinaryRetrievalCalls, 0,
  'A compatible speculative result must avoid duplicate retrieval');
assert.equal(speculativeDiagnostics.speculativeReused, true);
assert.equal(deterministicChecks, 1,
  'Follow-up validation must not add a second grounding-validator call');
assert.match(speculativeTurn.speech, /Tenant Item costs 125/u);

const guardedDecisions = [{
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  search: null, tool: null, nextQuestion: null, stateUpdate: null,
}, {
  decision: 'RESPONSE', response: 'Tenant Item costs 125.', clarification: null,
  evidenceIds: ['E1'], nextQuestion: null, stateUpdate: null,
}];
let guardedClaimChecks = 0;
let guardedRetrievalCalls = 0;
const guardedTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-guarded', usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use RESPONSE only for non-factual speech and SEARCH for facts.',
  latestUtterance: 'What is the tenant item price?', conversationHistory: [], state: {},
  runtimeProfile: {}, authorizedWorkflowTools: [], assignedTools: [], informationFields: [],
}, {
  invokeStructuredLlm: async () => guardedDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [], artifacts: {} }),
  retrieveEvidence: async () => {
    guardedRetrievalCalls += 1;
    return retrieval;
  },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('must not execute'); },
  validateGroundedClaims: async () => {
    guardedClaimChecks += 1;
    return {
      supported: guardedClaimChecks > 1,
      successClaimed: false,
      requestedFactAddressed: guardedClaimChecks > 1,
    };
  },
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(guardedRetrievalCalls, 1,
  'A factual direct RESPONSE rejected by grounding must be forced through SEARCH');
assert.equal(guardedTurn.decision.decision, 'RESPONSE');
assert.deepEqual(guardedTurn.evidenceIds, ['evidence-1']);
assert.equal(guardedDecisions.length, 0);

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
  tool: { name: 'perform_action', arguments: {} }, nextQuestion: null, stateUpdate: null,
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
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(workflowTurn.workflow.status, 'AWAITING_FIELD');
assert.equal(workflowTurn.state.activeWorkflowId, 'workflow-1');
assert.equal(workflowTurn.toolExecuted, false);
assert.equal(workflowTurn.provenance.initialDecision, 'TOOL');
assert.equal(workflowTurn.provenance.finalDecision, 'CLARIFY');
assert.equal(workflowTurn.provenance.workflowId, 'workflow-1');
assert.equal(workflowTurn.provenance.toolId, 'tool-1');
assert.equal(workflowTurn.provenance.clarificationReason, 'missing_workflow_field');
assert.equal(workflowDecisions.length, 0);

const contextualWorkflowDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: { contact_name: 'Sam' } },
  nextQuestion: null,
  stateUpdate: null,
}, { speech: 'Please confirm the collected value Sam.' }];
const contextualWorkflowTurn = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope, callId: 'call-contextual-tool',
  usageDirection: 'inbound', language: 'en',
  mainPrompt: 'Use the authorized tool for requested actions.',
  latestUtterance: 'Please perform it.',
  conversationHistory: [
    { role: 'user', content: 'The configured contact name is Sam.' },
    { role: 'assistant', content: 'I have that value.' },
  ],
  state: { lastReferencedRecordIds: ['selected-record'] },
  runtimeProfile: {}, authorizedWorkflowTools: [tool], assignedTools: [tool],
  informationFields: [{
    key: 'contact_name', label: 'Contact Name', type: 'text', required: true,
    question: 'What is the contact name?', requiredAction: 'perform_action',
  }],
}, {
  invokeStructuredLlm: async () => contextualWorkflowDecisions.shift(),
  loadPublishedContext: async () => ({ scope, publishedWorkflows: [workflow], artifacts: {} }),
  retrieveEvidence: async () => { throw new Error('tool route must not search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => { throw new Error('confirmation is still required'); },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: false }),
});
assert.equal(contextualWorkflowTurn.workflow.status, 'AWAITING_CONFIRMATION');
assert.equal(contextualWorkflowTurn.state.collectedToolFields.contact_name, 'Sam');
assert.deepEqual(contextualWorkflowTurn.state.lastReferencedRecordIds, ['selected-record'],
  'Workflow activation must preserve the selected record reference');
assert.equal(contextualWorkflowDecisions.length, 0);

const confirmationDecisions = [{
  decision: 'TOOL', response: '', clarification: null, search: null,
  tool: { name: 'perform_action', arguments: {} },
  nextQuestion: null,
  stateUpdate: { set: { confirmationStatus: 'confirmed' }, clear: [] },
}, {
  speech: 'The action completed successfully.',
  nextQuestion: { question: 'Would you like further help?', reason: 'Published continuation' },
}];
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
  loadPublishedContext: async () => ({
    scope, publishedWorkflows: [workflow], artifacts: {},
    publishedConversationGuidance: [{
      recordId: 'result-guidance', recordType: 'CONVERSATION_NODE',
      tenantId, agentId, knowledgeBaseId, publicationRevision: 4, published: true,
      nodeKey: 'operation_execution_result', intentClass: null,
      purpose: 'Report the verified execution result and offer further help.',
      situation: 'The authorized operation has returned a verified result.',
      examples: [], context: null, catalogReferences: [],
      nextQuestion: 'Would you like further help?',
    }],
  }),
  retrieveEvidence: async () => { throw new Error('tool route must not run factual search'); },
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {
    executed += 1;
    return { verified: true, success: true, output: { success: true } };
  },
  validateGroundedClaims: async () => ({
    supported: true, successClaimed: false, requestedFactAddressed: true,
  }),
  validateToolResultSpeechClaims: async () => ({ supported: true, successClaimed: true }),
});
assert.equal(executed, 1);
assert.equal(confirmedTurn.workflow.status, 'SUCCEEDED');
assert.equal(confirmedTurn.state.activeWorkflowId, null);
assert.equal(confirmedTurn.provenance.finalDecision, 'TOOL_RESULT');
assert.equal(confirmedTurn.provenance.validationResult, 'verified_tool_result');
assert.equal(confirmedTurn.speech,
  'The action completed successfully. Would you like further help?');
assert.equal(confirmedTurn.followUpValidation.accepted, true);
assert.equal(confirmationDecisions.length, 0);

const runtimeMetrics = {
  templateEngine: { version: 1, mode: 'active', turns: 0, searches: 0, workflows: 0 },
  turnLatency: [],
};
const searchMetric = recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch: 1, result: turn, retrievalDiagnostics: retrieval.diagnostics,
  turnStartedAt: 1_000, firstAudioAt: 1_400, firstAudioDeadlineMs: 2_000,
});
recordTemplateEngineTurnMetrics(runtimeMetrics, {
  epoch: 2, result: workflowTurn, turnStartedAt: 2_000,
  firstAudioAt: 4_500, firstAudioDeadlineMs: 2_000,
});
assert.equal(runtimeMetrics.templateEngine.turns, 2);
assert.equal(runtimeMetrics.templateEngine.searches, 1);
assert.equal(runtimeMetrics.templateEngine.workflows, 1);
assert.equal(runtimeMetrics.turnLatency.length, 2);
assert.equal(searchMetric.route, 'SEARCH');
assert.equal(searchMetric.responseClass, 'RESPONSE');
assert.equal(searchMetric.retrievalMs, retrieval.diagnostics.durationMs);
assert.equal(searchMetric.totalFirstAudioMs, 400);
assert.equal(searchMetric.firstAudioStatus, 'passed');
assert.equal(runtimeMetrics.turnLatency[1].retrievalMs, null);
assert.equal(runtimeMetrics.turnLatency[1].firstAudioStatus, 'missed');

console.log('Template-engine production retrieval and turn runtime verification passed.');
