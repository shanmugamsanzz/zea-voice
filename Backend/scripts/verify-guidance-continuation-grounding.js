import assert from 'node:assert/strict';
import {
  selectStrongCallerMessage,
  strongCallerMessageMatch,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { validateGroundedClaim } from '../src/voice/interaction/grounded-claim-validator.js';
import {
  resolveNextConfiguredQuestion,
  validateConfiguredFieldCollectionSpeech,
} from '../src/voice/interaction/next-question-policy.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { applyUnifiedGroundedTurn } from '../src/voice/interaction/unified-grounded-turn.js';

const message = (overrides = {}) => ({
  id: overrides.id ?? 'message-1', recordId: overrides.id ?? 'message-1',
  recordType: 'CONVERSATION_NODE', callerFacing: true,
  authoritativeData: {
    nodeType: 'message',
    variables: [
      { key: 'situation', value: 'The caller accepts the pending offer.' },
      { key: 'context', value: 'pending_question' },
    ],
  },
  content: 'Published caller-facing response.', retrievalContext: 'contextual',
  semanticScore: 0.94, semanticRank: 1, tokenCoverage: 0.1,
  retrievalScore: 0.88, channels: ['semantic'], rank: 1,
  ...overrides,
});

const contextualInput = {
  pendingQuestion: 'Would you like the available options?',
  understanding: { contextDependent: true, selectedEntities: [] },
};
assert.equal(strongCallerMessageMatch(message(), 'Yes, please continue', contextualInput), true);
assert.equal(selectStrongCallerMessage([
  message(),
  message({ id: 'runner-up', semanticScore: 0.86, semanticRank: 2, rank: 2 }),
], 'Yes, please continue', contextualInput)?.id, 'message-1');

assert.equal(strongCallerMessageMatch(message({ retrievalContext: 'primary' }), 'Explain it', {
  understanding: { contextDependent: false, selectedEntities: [{ key: 'item-a', name: 'Item A' }] },
}), false, 'a generic message must not override an explicit entity turn');

const catalogEvidence = {
  id: 'source-a', recordId: 'record-a', recordType: 'CATALOG_ITEM', callerFacing: true,
  content: 'Item A includes CBC and costs 125 INR.',
  authoritativeData: {
    itemKey: 'item-a', name: 'Item A', price: 125,
    attributes: [{ key: 'included_checks', value: ['CBC'] }],
  },
};
assert.equal(validateGroundedClaim('Item A includes CBC and costs 125 INR.', [catalogEvidence]).valid, true);
assert.equal(validateGroundedClaim('Item A includes MRI and costs 125 INR.', [catalogEvidence]).reason,
  'unsupported_structured_fact');
assert.equal(validateGroundedClaim('You should start taking this medication.', [catalogEvidence]).reason,
  'unsupported_medical_advice');

const actionField = {
  key: 'contact_name', label: 'Contact name', type: 'text', required: true,
  requiredAction: 'create_request', question: 'What name should I use?',
};
assert.equal(validateConfiguredFieldCollectionSpeech('What name should I use?', {
  fieldSchemas: [actionField], activeToolAuthorized: false,
}).reason, 'premature_configured_field_collection');
assert.equal(validateConfiguredFieldCollectionSpeech('What name should I use?', {
  fieldSchemas: [actionField], activeToolAuthorized: true,
}).valid, true);

const skippedGuidanceQuestion = resolveNextConfiguredQuestion({
  decision: { decision: 'answer', pendingQuestionRelevant: false },
  beforeState: {}, afterState: {}, fieldSchemas: [actionField], tools: [], actionEvidence: [],
  guidanceEvidence: [{
    recordId: 'guidance-1', authoritativeData: { nextQuestion: 'What name should I use?' },
  }],
});
assert.equal(skippedGuidanceQuestion, null);

const identity = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', callId: 'call' };
const memory = openGenericConversationState(identity, {}, 1, {
  pendingQuestion: { text: 'Would you like a general overview?', kind: 'conversation' },
});
memory.beginTurn('specific-turn');
const envelope = {
  found: true,
  sources: [
    { id: 'source-a', recordId: 'record-a', recordType: 'CATALOG_ITEM', content: catalogEvidence.content },
    { id: 'source-b', recordId: 'record-b', recordType: 'CATALOG_ITEM', content: 'Item B details.' },
  ],
  entities: [
    { id: 'record-a', key: 'item-a', name: 'Item A' },
    { id: 'record-b', key: 'item-b', name: 'Item B' },
  ],
};
const unsupportedEntity = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['source-a'],
    stateUpdate: {
      currentTopic: 'Item B', knownEntityKeys: ['item-b'], collectedInformation: {},
      correctedFields: [], pendingQuestionRelevant: true, contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope, memory, turnToken: 'specific-turn',
  evidence: [catalogEvidence, {
    ...catalogEvidence, id: 'source-b', recordId: 'record-b', content: 'Item B details.',
    authoritativeData: { itemKey: 'item-b', name: 'Item B' },
  }],
  finalizedUtterance: 'Tell me about Item B.',
});
assert.equal(unsupportedEntity.valid, false);
assert.equal(unsupportedEntity.reason, 'unsupported_selected_entity');

memory.beginTurn('supported-specific-turn');
const supportedEntity = applyUnifiedGroundedTurn({
  rawDecision: JSON.stringify({
    decision: 'answer', answer: catalogEvidence.content, evidenceIds: ['source-a'],
    stateUpdate: {
      currentTopic: 'Item A', knownEntityKeys: ['item-a'], collectedInformation: {},
      correctedFields: [], pendingQuestionRelevant: true, contextDependent: false,
    },
    pendingQuestion: null, toolRequest: null,
  }),
  groundingEnvelope: envelope, memory, turnToken: 'supported-specific-turn',
  evidence: [catalogEvidence, {
    ...catalogEvidence, id: 'source-b', recordId: 'record-b', content: 'Item B details.',
    authoritativeData: { itemKey: 'item-b', name: 'Item B' },
  }],
  finalizedUtterance: 'Tell me about Item A.',
});
assert.equal(supportedEntity.valid, true);
assert.equal(supportedEntity.pendingQuestion, null);
assert.equal(supportedEntity.answer.includes('general overview'), false);

console.log('Guidance, continuation and grounded validation verification passed.');
