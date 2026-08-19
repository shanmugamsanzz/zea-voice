import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  configuredMessageQuestion,
  openGenericConversationState,
  seedConfiguredQuestion,
} from '../src/voice/interaction/generic-conversation-state.js';
import { selectStrongCallerMessage } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';

const identity = {
  tenantId: 'tenant-welcome', workspaceId: 'workspace-welcome',
  agentId: 'agent-welcome', callId: 'call-welcome',
};
const welcome = 'வணக்கம், நான் AI agent பேசுறேன். நான் பேசுறது சரியான நபர் கூடங்களா?.';
const extracted = configuredMessageQuestion(welcome, 'configured_welcome_question');
assert.equal(extracted?.key, 'configured_welcome_question');
assert.equal(extracted?.text, 'நான் பேசுறது சரியான நபர் கூடங்களா?');
assert.equal(extracted?.kind, 'conversation');
assert.equal(configuredMessageQuestion('Welcome without a question.'), null);

const memory = openGenericConversationState(identity, { conversationLanguage: 'ta' });
const pending = seedConfiguredQuestion(memory, welcome, 'configured_welcome_question');
assert.deepEqual(pending, extracted);
assert.equal(memory.snapshot().pendingQuestion?.text, extracted.text);

const overview = 'Published overview response.';
const overviewMessage = {
  id: 'published:conversation:overview', recordId: 'conversation-overview',
  recordType: 'CONVERSATION_NODE', callerFacing: true, content: overview,
  semanticScore: 0.96, retrievalScore: 0.95, tokenCoverage: 0.1,
  channels: ['semantic'], retrievalContext: 'contextual', rank: 1,
  authoritativeData: {
    nodeType: 'message', nodeKey: 'complete-overview',
    variables: [
      { key: 'situation', value: 'The caller positively confirms the configured welcome question.' },
      { key: 'context', value: 'no_selected_entity' },
    ],
  },
};
for (const utterance of [
  'ம் ஆமாங்க', 'சரிங்க சொல்லுங்க', 'yes, speaking',
  'yeah that is me, please continue', 'correct, go ahead',
]) {
  const selected = selectStrongCallerMessage([overviewMessage], utterance, {
    pendingQuestion: memory.snapshot().pendingQuestion?.text,
    knownEntities: [],
    understanding: { contextDependent: true, selectedEntities: [] },
  });
  assert.equal(selected?.recordId, overviewMessage.recordId,
    `semantic acknowledgement should select overview: ${utterance}`);
}

// The direct caller-facing response path completes the configured welcome
// question instead of preserving or repeating it.
memory.setPendingQuestion(null);
assert.equal(memory.snapshot().pendingQuestion, null);

const existingMemory = openGenericConversationState({ ...identity, callId: 'call-existing' }, {}, Date.now(), {
  pendingQuestion: { key: 'existing', text: 'Existing authorized question?', kind: 'field' },
});
seedConfiguredQuestion(existingMemory, 'Configured welcome question?', 'configured_welcome_question');
assert.equal(existingMemory.snapshot().pendingQuestion?.key, 'existing',
  'configured welcome must not overwrite an existing authorized pending question');

const conversation = fs.readFileSync(new URL(
  '../../docs/knowledge-base/shanmuga-hospital-conversation-script-production.txt', import.meta.url,
), 'utf8');
const prompt = fs.readFileSync(new URL(
  '../../docs/knowledge-base/shanmuga-hospital-master-system-prompt-production.txt', import.meta.url,
), 'utf8');
assert.match(conversation, /positively confirms the immediately preceding configured welcome or identity question/u);
assert.match(conversation, /STAGE: call_purpose[\s\S]*TYPE: message[\s\S]*why the agent called/u);
assert.equal((conversation.match(/எங்ககிட்ட Master Health Checkupல Silver, Gold, Platinum இருக்கு/gu) ?? []).length, 1,
  'one approved overview response must remain');
assert.match(conversation, /otherwise reserve preparation for the booking confirmation stage so it is spoken once/u);
assert.match(conversation, /has not already been spoken in the current call/u);
assert.match(prompt, /positively confirms the configured welcome or identity question/u);
assert.match(prompt, /Do not repeat an overview, preparation instruction or completed question/u);

memory.close();
existingMemory.close();
console.log(JSON.stringify({
  task: 'welcome-acknowledgement-memory', passed: true,
  configuredWelcomeSeeded: true, semanticAcknowledgements: 5,
  completedWelcomeCleared: true, callPurposePublished: true,
  repeatedPreparationPrevented: true,
}));
