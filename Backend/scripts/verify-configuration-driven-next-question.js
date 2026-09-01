import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  advanceSchemaDrivenWorkflowState,
  composeConfiguredTurnResponse,
  resolveNextConfiguredQuestion,
} from '../src/voice/interaction/next-question-policy.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { normalizeLiveCallFrame } from '../src/voice/interaction/conversation-memory-state.js';

const tools = [{
  id: 'tool-1',
  name: 'create_visit',
  configuration: {
    inputSchema: {
      type: 'object',
      required: ['customer_name', 'visit_date'],
      properties: {
        customer_name: { type: 'string' },
        visit_date: { type: 'string' },
      },
    },
  },
}];
const fieldSchemas = [
  {
    key: 'customer_name', required: true, requiredAction: 'create_visit',
    question: 'Please tell me your name.',
  },
  {
    key: 'visit_date', required: true, requiredAction: 'create_visit',
    question: 'Which date do you prefer?',
  },
];
const actionEvidence = [{
  recordId: 'workflow-record-1',
  activationAllowed: true,
  authoritativeData: {
    actionType: 'configured_tool',
    actionConfig: { toolIdentifier: 'create_visit' },
  },
}];

function resolve(overrides = {}) {
  return resolveNextConfiguredQuestion({
    decision: {}, beforeState: {}, afterState: {}, fieldSchemas, tools,
    actionEvidence, guidanceEvidence: [], ...overrides,
  });
}

// A stale action-field question is never resumed without an active,
// Workflow-authorized tool request.
const resumed = resolve({
  decision: { pendingQuestionRelevant: true },
  beforeState: {
    pendingQuestion: { key: 'visit_date', text: 'Which date do you prefer?', kind: 'field' },
  },
  afterState: { collectedInformation: {} },
  fieldSchemas: [], tools: [], actionEvidence: [],
});
assert.equal(resumed, null);
assert.equal(composeConfiguredTurnResponse('The office is on Central Road.', resumed),
  'The office is on Central Road.');

// A topic change explicitly discards an irrelevant pending question.
const discarded = resolve({
  decision: { pendingQuestionRelevant: false },
  beforeState: {
    pendingQuestion: { key: 'visit_date', text: 'Which date do you prefer?', kind: 'field' },
  },
  afterState: { collectedInformation: {} },
  fieldSchemas: [], tools: [], actionEvidence: [],
});
assert.equal(discarded, null);

// UI schema array order is authoritative for tool-field collection.
const firstField = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: {} },
});
assert.equal(firstField.source, 'ui_tool_field_question');
assert.equal(firstField.key, 'customer_name');
assert.equal(firstField.question, 'Please tell me your name.');
assert.equal(firstField.activeToolRequest.authorizationRecordId, 'workflow-record-1');
assert.equal(firstField.activeToolRequest.workflowState.selectedRecord.recordId,
  'workflow-record-1');
assert.deepEqual(firstField.activeToolRequest.workflowState.requiredFields,
  ['customer_name', 'visit_date']);
assert.deepEqual(firstField.activeToolRequest.workflowState.missingFields,
  ['customer_name', 'visit_date']);

const secondField = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: { customer_name: 'Ravi' } },
});
assert.equal(secondField.key, 'visit_date');
assert.deepEqual(secondField.activeToolRequest.workflowState.collectedFields,
  { customer_name: 'Ravi' });
assert.deepEqual(secondField.activeToolRequest.workflowState.missingFields, ['visit_date']);

// Completed fields cannot be asked again, including through saved pending state.
const completed = resolve({
  decision: { activeToolRequest: { name: 'create_visit' }, pendingQuestionRelevant: true },
  beforeState: {
    pendingQuestion: { key: 'customer_name', text: 'Please tell me your name.', kind: 'field' },
  },
  afterState: { collectedInformation: { customer_name: 'Ravi', visit_date: '2026-08-20' } },
});
assert.equal(completed.kind, 'confirmation');
assert.match(completed.question, /Ravi/u);
assert.match(completed.question, /2026-08-20/u);
assert.deepEqual(completed.activeToolRequest.workflowState.missingFields, []);

// A UI tool can never start field collection without published Workflow
// authorization, even if the model names the assigned tool.
const unauthorized = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: {} },
  actionEvidence: [],
});
assert.equal(unauthorized, null);

const semanticOnlyAction = resolve({
  decision: { activeToolRequest: { name: 'create_visit' } },
  afterState: { collectedInformation: {} },
  actionEvidence: actionEvidence.map((entry) => ({ ...entry, activationAllowed: false })),
});
assert.equal(semanticOnlyAction, null);

// Stored authorization permits later turns to continue without requiring the
// same Workflow record to be retrieved again.
const authorizedContinuation = resolve({
  beforeState: {
    activeToolRequest: {
      name: 'create_visit', status: 'collecting_information',
      authorizationRecordId: 'workflow-record-1',
    },
  },
  afterState: { collectedInformation: { customer_name: 'Ravi' } },
  actionEvidence: [],
});
assert.equal(authorizedContinuation.key, 'visit_date');

// Partial action values stay missing until they satisfy the assigned schema.
const contactTool = {
  id: 'tool-2', name: 'send_request',
  inputSchema: {
    type: 'object', required: ['contact_number'],
    properties: {
      contact_number: { type: 'string', format: 'phone', minLength: 8 },
    },
    'x-requires-confirmation': true,
    'x-confirmation-message': 'Continue with these details?',
  },
};
const contactFields = [{
  key: 'contact_number', label: 'Contact number', type: 'phone', required: true,
  requiredAction: 'send_request', question: 'Please provide the complete contact number.',
}];
const contactEvidence = [{
  recordId: 'workflow-record-2', activationAllowed: true,
  authoritativeData: {
    actionType: 'configured_tool', actionConfig: { toolIdentifier: 'send_request' },
  },
}];
const partialContact = resolve({
  decision: { activeToolRequest: { name: 'send_request' } },
  afterState: { collectedInformation: { contact_number: '96' } },
  fieldSchemas: contactFields, tools: [contactTool], actionEvidence: contactEvidence,
});
assert.equal(partialContact.key, 'contact_number');
assert.equal(partialContact.kind, 'field');
const completeContact = resolve({
  decision: { activeToolRequest: { name: 'send_request' } },
  afterState: { collectedInformation: { contact_number: '9360235493' } },
  fieldSchemas: contactFields, tools: [contactTool], actionEvidence: contactEvidence,
});
assert.equal(completeContact.kind, 'confirmation');
assert.match(completeContact.question, /9360235493/u);
assert.equal(completeContact.activeToolRequest.workflowState.confirmationStatus,
  'awaiting_confirmation');
assert.deepEqual(completeContact.activeToolRequest.workflowState.missingFields, []);

// The complete schema-derived Workflow snapshot survives the persistent call
// frame boundary and can continue on the next turn without reactivating from
// arbitrary text.
const persistedWorkflow = normalizeLiveCallFrame({
  activeToolRequest: completeContact.activeToolRequest,
  collectedInformation: { contact_number: '9360235493' },
});
assert.equal(persistedWorkflow.activeToolRequest.workflowState.selectedRecord.recordId,
  'workflow-record-2');
assert.deepEqual(persistedWorkflow.activeToolRequest.workflowState.requiredFields,
  ['contact_number']);
assert.deepEqual(persistedWorkflow.activeToolRequest.workflowState.missingFields, []);
assert.equal(persistedWorkflow.activeToolRequest.workflowState.confirmationStatus,
  'awaiting_confirmation');
const confirmedWorkflow = advanceSchemaDrivenWorkflowState({
  activeRequest: completeContact.activeToolRequest,
  fieldSchemas: contactFields,
  collectedInformation: { contact_number: '9360235493' },
  tools: [contactTool],
  actionEvidence: [],
  confirmationAccepted: true,
});
assert.equal(confirmedWorkflow.valid, true);
assert.equal(confirmedWorkflow.activeToolRequest.status, 'ready');
assert.equal(confirmedWorkflow.workflowState.confirmationStatus, 'confirmed');

const restoredState = openGenericConversationState({
  tenantId: 'tenant-persisted', agentId: 'agent-persisted', callId: 'call-persisted',
}, {
  cachePolicy: 'current_call_only', conversationMemoryFields: contactFields,
}, Date.now(), persistedWorkflow);
assert.equal(restoredState.snapshot().activeToolRequest.workflowState.selectedRecord.recordId,
  'workflow-record-2');
assert.deepEqual(restoredState.snapshot().activeToolRequest.workflowState.missingFields, []);
restoredState.close();

// Completed values are retained. Only a decision-declared correction may
// replace a value that was already confirmed by the caller.
const state = openGenericConversationState({
  tenantId: 'tenant-action', agentId: 'agent-action', callId: 'call-action',
}, {
  cachePolicy: 'current_call_only', conversationMemoryFields: contactFields,
});
const firstTurn = state.beginTurn();
state.applyGroundedDecision({ stateUpdate: {
  collectedInformation: { contact_number: '9360235493' }, correctedFields: [],
} }, { turnToken: firstTurn });
const unchangedTurn = state.beginTurn();
state.applyGroundedDecision({ stateUpdate: {
  collectedInformation: { contact_number: '9000000000' }, correctedFields: [],
} }, { turnToken: unchangedTurn });
assert.equal(state.snapshot().collectedInformation.contact_number, '9360235493');
const correctionTurn = state.beginTurn();
state.applyGroundedDecision({ stateUpdate: {
  collectedInformation: { contact_number: '9000000000' },
  correctedFields: ['contact_number'],
} }, { turnToken: correctionTurn });
assert.equal(state.snapshot().collectedInformation.contact_number, '9000000000');

// Conversation Guidance is the final configured source before waiting.
const guidance = resolve({
  decision: { decision: 'answer', pendingQuestion: 'Would you like to continue?' },
  fieldSchemas: [], tools: [], actionEvidence: [],
  guidanceEvidence: [{
    recordId: 'guidance-record-1',
    content: 'Continue naturally.',
    authoritativeData: {
      variables: [{ key: 'nextQuestion', value: 'Would you like to continue?' }],
    },
  }],
});
assert.equal(guidance.source, 'selected_conversation_guidance');
assert.equal(guidance.question, 'Would you like to continue?');

// With no configured source, the agent waits; it cannot invent a sales,
// booking, or other automatic follow-up.
const waits = resolve({ fieldSchemas: [], tools: [], actionEvidence: [], guidanceEvidence: [] });
assert.equal(waits, null);
assert.equal(composeConfiguredTurnResponse('Here is the approved answer.', waits), 'Here is the approved answer.');

const resolverSource = readFileSync(
  new URL('../src/voice/interaction/next-question-policy.js', import.meta.url), 'utf8',
);
assert.doesNotMatch(resolverSource, /package|appointment|booking|sales/iu);

console.log('Configuration-driven next-question verification passed.');
