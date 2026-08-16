import assert from 'node:assert/strict';
import { genericConversationStateFields, openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';

const identity = { tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a' };
const settings = {
  conversationMemoryFields: [
    { key: 'contact_name', label: 'Contact name', type: 'text', required: true, question: 'What name should I use?' },
    { key: 'preferred_date', label: 'Preferred date', type: 'text', required: true, question: 'Which date do you prefer?' },
  ],
};
const memory = openGenericConversationState(identity, settings, 1, {
  pendingQuestion: { key: 'preferred_date', text: 'Which date do you prefer?', kind: 'field' },
  collectedInformation: {},
  language: 'en',
});
memory.beginTurn('turn-1');

const envelope = {
  found: true,
  sources: [{ id: 'source-1', recordId: 'fact-1', recordType: 'GENERAL_KNOWLEDGE', content: 'The office is on Central Road.' }],
  entities: [],
};
const sideAnswer = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: {
      currentTopic: 'office location', knownEntityKeys: [], collectedInformation: {},
      correctedFields: [], language: 'en', pendingQuestionRelevant: true,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-1',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
});
assert.equal(sideAnswer.valid, true);
assert.equal(sideAnswer.answer, 'The office is on Central Road. Which date do you prefer?');
assert.equal(sideAnswer.pendingQuestion.key, 'preferred_date');
assert.equal(sideAnswer.state.lastAnswer, sideAnswer.answer);
assert.equal(sideAnswer.state.recentTurns.at(-1).role, 'assistant');
assert.equal(sideAnswer.state.recentTurns.at(-1).content, sideAnswer.answer);
assert.deepEqual(Object.keys(sideAnswer.state).sort(), [...genericConversationStateFields].sort());

memory.beginTurn('turn-2');
const corrected = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: {
      currentTopic: 'office location', knownEntityKeys: [],
      collectedInformation: { preferred_date: 'Friday' }, correctedFields: ['preferred_date'],
      language: 'en', pendingQuestionRelevant: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-2',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
});
assert.equal(corrected.state.collectedInformation.preferred_date, 'Friday');
assert.equal(corrected.state.pendingQuestion, null);

const stale = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: 'The office is on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: { currentTopic: 'stale topic', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-1',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
});
assert.equal(stale.valid, false);
assert.equal(stale.reason, 'stale_turn');
assert.equal(memory.snapshot().currentTopic, 'office location');

memory.beginTurn('turn-3');
const contradicted = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: 'The office is not on Central Road.', evidenceIds: ['source-1'],
    stateUpdate: { currentTopic: 'incorrect location', knownEntityKeys: [], collectedInformation: {}, correctedFields: [] },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope,
  memory,
  turnToken: 'turn-3',
  fieldSchemas: settings.conversationMemoryFields,
  evidence: envelope.sources,
});
assert.equal(contradicted.valid, false);
assert.equal(contradicted.reason, 'unsupported_negation');
assert.equal(memory.snapshot().currentTopic, 'office location');

memory.close();

const actionSettings = {
  conversationMemoryFields: [
    { key: 'contact_name', label: 'Contact name', type: 'text', required: true, requiredAction: 'create_request', question: 'What name should I use?' },
  ],
};
const actionTool = {
  id: 'tool-1', name: 'create_request', description: 'Create a configured request',
  configuration: {
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['contact_name'],
      properties: { contact_name: { type: 'string', minLength: 2 } },
    },
  },
};
const actionEnvelope = {
  found: true,
  sources: [{
    id: 'item-source', recordId: 'item-record', recordType: 'CATALOG_ITEM',
    content: 'Priority service is an approved selectable service.',
  }],
  entities: [{ id: 'item-1', key: 'priority-service', name: 'Priority service', sourceId: 'item-source' }],
};
const actionEvidence = [
  {
    id: 'item-source', recordId: 'item-record', recordType: 'CATALOG_ITEM',
    tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a', publicationRevision: 3,
    callerFacing: true, content: 'Priority service is an approved selectable service.',
  },
  {
    id: 'workflow-source', recordId: 'workflow-record', recordType: 'WORKFLOW_RULE',
    tenantId: 'tenant-a', agentId: 'agent-a', knowledgeBaseId: 'kb-a', publicationRevision: 3,
    callerFacing: false, activationAllowed: true,
    authoritativeData: {
      actionType: 'configured_tool',
      actionConfig: { toolIdentifier: 'create_request', requiresCatalogItem: true },
    },
  },
];
const evidenceScope = {
  tenantId: 'tenant-a', agentId: 'agent-a',
  publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 3 }],
};
const actionMemory = openGenericConversationState(
  { ...identity, callId: 'call-action' }, actionSettings,
);
actionMemory.beginTurn('action-turn');
const sameTurnAction = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'Asha' }, correctedFields: [],
      activeToolRequest: { name: 'create_request' }, pendingQuestionRelevant: false,
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'Asha' } },
  }),
  groundingEnvelope: actionEnvelope,
  memory: actionMemory,
  turnToken: 'action-turn',
  fieldSchemas: actionSettings.conversationMemoryFields,
  tools: [actionTool],
  evidence: actionEvidence,
  evidenceScope,
});
assert.equal(sameTurnAction.valid, true);
assert.equal(sameTurnAction.toolRequest.name, 'create_request');
assert.equal(sameTurnAction.state.knownEntities[0].key, 'priority-service');
assert.equal(sameTurnAction.state.collectedInformation.contact_name, 'Asha');

const unauthorizedMemory = openGenericConversationState(
  { ...identity, callId: 'call-unauthorized' }, actionSettings,
);
unauthorizedMemory.beginTurn('unauthorized-turn');
const unauthorizedAction = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'Asha' }, correctedFields: [],
      activeToolRequest: { name: 'create_request' }, pendingQuestionRelevant: false,
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'Asha' } },
  }),
  groundingEnvelope: actionEnvelope,
  memory: unauthorizedMemory,
  turnToken: 'unauthorized-turn',
  fieldSchemas: actionSettings.conversationMemoryFields,
  tools: [actionTool],
  evidence: actionEvidence.map((source) => (
    source.recordType === 'WORKFLOW_RULE' ? { ...source, activationAllowed: false } : source
  )),
  evidenceScope,
});
assert.equal(unauthorizedAction.valid, false);
assert.equal(unauthorizedAction.reason, 'unauthorized_tool_request');
assert.equal(unauthorizedAction.state.knownEntities[0].key, 'priority-service');
assert.equal(unauthorizedAction.state.activeToolRequest, null);

const invalidArgumentsMemory = openGenericConversationState(
  { ...identity, callId: 'call-invalid-arguments' }, actionSettings,
);
invalidArgumentsMemory.beginTurn('invalid-arguments-turn');
const invalidArguments = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'action', answer: '', evidenceIds: ['item-source'],
    stateUpdate: {
      currentTopic: 'priority service', knownEntityKeys: ['priority-service'],
      collectedInformation: { contact_name: 'A' }, correctedFields: [],
      activeToolRequest: { name: 'create_request' }, pendingQuestionRelevant: false,
    },
    pendingQuestion: null,
    toolRequest: { name: 'create_request', arguments: { contact_name: 'A' } },
  }),
  groundingEnvelope: actionEnvelope,
  memory: invalidArgumentsMemory,
  turnToken: 'invalid-arguments-turn',
  fieldSchemas: actionSettings.conversationMemoryFields,
  tools: [actionTool], evidence: actionEvidence, evidenceScope,
});
assert.equal(invalidArguments.valid, false);
assert.equal(invalidArguments.reason, 'invalid_tool_arguments');
assert.equal(invalidArguments.state.knownEntities[0].key, 'priority-service');
assert.equal(invalidArguments.state.activeToolRequest, null);

actionMemory.close();
unauthorizedMemory.close();
invalidArgumentsMemory.close();
console.log('Unified grounded turn verification passed.');
