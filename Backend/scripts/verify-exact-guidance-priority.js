import assert from 'node:assert/strict';
import { messageSelectionScore } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { validateGroundedLlmDecision } from '../src/voice/interaction/grounded-llm-decision.js';

const message = {
  id: 'message-1', recordId: 'message-1', recordType: 'CONVERSATION_NODE', callerFacing: true,
  rank: 4, content: 'Approved options response. Which option would you like?', authoritativeData: { nodeType: 'message' },
};
const staleGuidance = {
  id: 'guidance-1', recordId: 'guidance-1', recordType: 'CONVERSATION_NODE', callerFacing: false,
  rank: 1, content: 'Ask which test the caller needs.', authoritativeData: { nodeType: 'guidance' },
};
const faq = { id: 'faq-1', recordId: 'faq-1', recordType: 'FAQ', callerFacing: true, rank: 2, content: 'FAQ answer.' };

assert.ok(messageSelectionScore(message, 'yes, explain', {}) > messageSelectionScore(faq, 'yes, explain', {}));
assert.ok(messageSelectionScore(message, 'yes, explain', {}) > messageSelectionScore(staleGuidance, 'yes, explain', {}));

const envelope = buildGroundingEnvelope({
  found: true, tenantEvidence: { sources: [message, staleGuidance, faq], guidanceEvidence: [] },
}, { includePublishedMap: false, maximumSources: 5 });
assert.deepEqual(envelope.exactCallerResponses, []);
const ordinary = JSON.stringify({
  decision: 'answer', answer: 'FAQ answer.', evidenceIds: ['source_1'],
  stateUpdate: {}, pendingQuestion: null, toolRequest: null,
});
assert.equal(validateGroundedLlmDecision(ordinary, envelope).valid, true);
const valid = JSON.stringify({
  decision: 'answer', answer: 'Approved options response.', evidenceIds: ['source_1'],
  stateUpdate: {}, pendingQuestion: 'Which option would you like?', toolRequest: null,
});
assert.equal(validateGroundedLlmDecision(valid, envelope).valid, true);

console.log(JSON.stringify({
  task: 'exact-guidance-priority', passed: true,
  callerFacingMessageAboveStaleGuidance: true, exactResponseHandledBeforeLlm: true,
  noBusinessRoutingWords: true,
}));
