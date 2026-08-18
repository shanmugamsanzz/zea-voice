import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolatedRetrievalQueries, messageSelectionScore, selectStrongCallerMessage } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';

const latest = 'Tell me what is included in the advanced option';
const queries = isolatedRetrievalQueries({
  query: latest,
  currentTopic: 'previous topic',
  requestedFacts: ['price', 'features'],
  constraints: ['weekday only'],
  contextualReferences: ['that option'],
  understanding: { requestType: 'details', contextDependent: true },
});
assert.equal(queries.primary, latest);
assert.match(queries.contextual, /previous topic/u);
assert.match(queries.contextual, /price features/u);
assert.match(queries.contextual, /weekday only/u);

const unrelatedTurn = isolatedRetrievalQueries({
  query: 'Tell me about a completely new subject',
  currentTopic: 'old subject', knownEntities: [{ key: 'old-item', name: 'Old Item' }],
  pendingQuestion: 'Old pending question', recentTurns: [{ role: 'user', content: 'Old context' }],
});
assert.equal(unrelatedTurn.primary, 'Tell me about a completely new subject');
assert.equal(unrelatedTurn.contextual, '');

const baseMessage = {
  recordType: 'CONVERSATION_NODE', callerFacing: true,
  authoritativeData: {
    nodeType: 'message',
    variables: [{ key: 'situation', value: 'The caller requests a general overview.' }, { key: 'context', value: 'any' }],
  },
  channels: ['semantic'], semanticRank: 1, tokenCoverage: 0.2,
  retrievalScore: 0.75, retrievalContext: 'primary', rank: 1,
};
const relevant = { ...baseMessage, id: 'relevant', semanticScore: 0.93 };
const unrelated = { ...baseMessage, id: 'unrelated', semanticScore: 0.84, semanticRank: 2, rank: 2 };
assert.equal(messageSelectionScore(relevant, latest) > messageSelectionScore(unrelated, latest), true);
assert.equal(selectStrongCallerMessage([unrelated, relevant], latest)?.id, 'relevant');
assert.equal(selectStrongCallerMessage([
  relevant,
  { ...relevant, id: 'ambiguous', semanticScore: 0.91, rank: 2 },
], latest), null);
assert.equal(selectStrongCallerMessage([
  { ...relevant, id: 'stale', retrievalContext: 'contextual' },
], latest), null);

const memory = openGenericConversationState({
  tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', callId: 'call',
}, {}, 1);
memory.beginTurn('turn');
const applied = memory.applyGroundedDecision({
  stateUpdate: {
    requestType: 'comparison', currentTopic: 'two selected options',
    requestedFacts: ['price', 'features'], constraints: ['under 100'],
    contextualReferences: ['both options'], contextDependent: true,
  },
}, { turnToken: 'turn' });
assert.equal(applied.state.requestType, 'comparison');
assert.deepEqual(applied.state.requestedFacts, ['price', 'features']);
assert.deepEqual(applied.state.constraints, ['under 100']);
assert.deepEqual(applied.state.contextualReferences, ['both options']);
assert.equal(applied.state.contextDependent, true);

memory.beginTurn('ordinary');
const preserved = memory.applyGroundedDecision({ stateUpdate: {} }, { turnToken: 'ordinary' });
assert.equal(preserved.state.requestType, 'comparison');
assert.deepEqual(preserved.state.requestedFacts, ['price', 'features']);

const runtimeSources = [
  '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js',
  '../src/voice/interaction/grounded-llm-decision.js',
  '../src/voice/interaction/generic-conversation-state.js',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
for (const forbidden of ['Shanmuga', 'Hospital', 'Silver', 'Gold', 'Platinum']) {
  assert.equal(runtimeSources.includes(forbidden), false, `runtime must not contain tenant vocabulary: ${forbidden}`);
}

memory.close();
console.log('Generic meaning resolution verification passed.');
