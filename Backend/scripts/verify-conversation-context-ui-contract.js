import assert from 'node:assert/strict';
import { createNormalTurnInput } from '../src/knowledge-bases/normal-turn-contract.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { completeConversationTurnPairs } from '../src/knowledge-engine/conversation-turn-context.js';

const scope = Object.freeze({
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  agentId: 'c1000000-0000-4000-8000-000000000002',
  callId: 'c1000000-0000-4000-8000-000000000003',
});

const limited = openGenericConversationState(scope, {
  conversationContextMode: 'last_n_turns', conversationContextTurns: 5,
});
for (let index = 1; index <= 6; index += 1) {
  limited.append({ role: 'user', content: `caller ${index}` });
  limited.append({ role: 'assistant', content: `agent ${index}` });
}
limited.append({ role: 'user', content: 'current unfinished caller question' });
const limitedSnapshot = limited.snapshot();
assert.equal(limitedSnapshot.recentTurns.length, 11,
  'Storage must keep five completed pairs plus the current unfinished caller message');
const limitedTurn = createNormalTurnInput({
  ...scope, finalizedQuestion: 'current unfinished caller question', memory: limitedSnapshot,
});
assert.equal(limitedTurn.memory.recentTurns.length, 10);
assert.equal(completeConversationTurnPairs(limitedTurn.memory.recentTurns).length, 5);
assert.equal(limitedTurn.memory.recentTurns[0].content, 'caller 2');
limited.close();

const pendingScope = Object.freeze({ ...scope, callId: 'c1000000-0000-4000-8000-000000000005' });
const pending = openGenericConversationState(pendingScope, {
  conversationContextMode: 'last_n_turns', conversationContextTurns: 2,
  conversationMemoryFields: [{
    key: 'contact_number', label: 'Contact Number', type: 'phone', required: true,
    question: 'What is your contact number?',
  }],
});
pending.setPendingQuestion({
  key: 'contact_number', text: 'What is your contact number?', kind: 'field',
});
const pendingTurn = createNormalTurnInput({
  ...pendingScope, finalizedQuestion: 'It is 9360235493', memory: pending.snapshot(),
});
assert.equal(pendingTurn.memory.pendingClarification.key, 'contact_number',
  'A configured active question must cross the normal-turn boundary');
pending.close();

const fullScope = Object.freeze({ ...scope, callId: 'c1000000-0000-4000-8000-000000000004' });
const full = openGenericConversationState(fullScope, {
  conversationContextMode: 'full_current_call', conversationContextTurns: 5,
});
for (let index = 1; index <= 12; index += 1) {
  full.append({ role: 'user', content: index === 2
    ? 'caller unique-retention-topic' : `caller full ${index}` });
  full.append({ role: 'assistant', content: `agent full ${index}` });
}
const fullSnapshot = full.snapshot();
assert.equal(fullSnapshot.recentTurns.length, 24,
  'Full Current Call must retain every finalized message until hangup');
const fullTurn = createNormalTurnInput({
  ...fullScope, finalizedQuestion: 'continue unique-retention-topic', memory: fullSnapshot,
});
assert.ok(fullTurn.memory.recentTurns.length < fullSnapshot.recentTurns.length,
  'Full history must be retained separately from relevant LLM context');
assert.equal(fullTurn.memory.recentTurns.length % 2, 0);
assert.equal(completeConversationTurnPairs(fullTurn.memory.recentTurns).length,
  fullTurn.memory.recentTurns.length / 2);
assert.ok(fullTurn.memory.recentTurns.some((entry) => entry.content.includes('unique-retention-topic')));
assert.ok(fullTurn.memory.recentTurns.some((entry) => entry.content === 'caller full 12'),
  'The latest complete pair must remain available for contextual follow-ups');
assert.ok(fullTurn.memory.recentTurns.some((entry) => entry.content === 'agent full 12'));
full.close();

console.log(JSON.stringify({
  gate: 'conversation-context-ui-contract',
  recentTurnPairs: 5,
  fullCurrentCallMessagesRetained: fullSnapshot.recentTurns.length,
  fullCurrentCallRelevantMessagesSelected: fullTurn.memory.recentTurns.length,
  completePairsOnly: true,
}, null, 2));
