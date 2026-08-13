import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAgentSystemPrompt } from '../src/agents/agent-runtime.service.js';
import { normalizeLiveCallFrame } from '../src/voice/interaction/conversation-memory-state.js';
import {
  compactLiveCallMemoryContext,
  openLiveCallMemory,
} from '../src/voice/interaction/live-call-memory.js';
import {
  buildGroundingEnvelope,
  createGroundedJsonStreamDecoder,
  validateGroundedSpokenSentences,
} from '../src/voice/interaction/grounded-llm-response.js';

const genericKeys = [
  'activeToolRequest', 'collectedInformation', 'currentTopic', 'knownEntities',
  'language', 'lastAnswer', 'pendingQuestion', 'recentTurns',
].sort();
const persisted = normalizeLiveCallFrame({
  currentStage: 'legacy-stage', activeCategory: { key: 'group-a', name: 'Group A' },
  selectedItem: { key: 'item-a', name: 'Item A' },
  currentTopic: 'Item A', pendingQuestion: { key: 'date', text: 'Which date?', kind: 'field' },
  language: 'ta', fields: { customer: 'Mitra' },
  recentTurns: [{ role: 'user', content: 'details' }], lastAnswer: 'Approved details.',
  activeToolRequest: { name: 'configured_action', status: 'pending' },
});
assert.deepEqual(Object.keys(persisted).sort(), genericKeys);
assert.equal(persisted.knownEntities.some((item) => item.key === 'item-a'), true);
assert.deepEqual(persisted.collectedInformation, { customer: 'Mitra' });

const settings = {
  conversationMemoryFields: [
    { key: 'customer', label: 'Customer', type: 'text', required: true, question: 'Your name?' },
  ],
};
const memory = openLiveCallMemory({
  tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', callId: 'call',
}, settings, Date.now(), persisted);
memory.observeAssistantResponse('Which date?');
memory.applyGroundedDecision({
  intent: 'ask location', questionType: 'side_question', currentTopic: 'location',
  topicChanged: true, pendingQuestionRelevant: true, flowAction: 'side_question',
  selectedEntities: [],
});
assert.match(memory.prepareAssistantResponse('The approved location is Central City.'), /Which date\?/u);
memory.observeAssistantResponse('Which option?');
memory.applyGroundedDecision({
  intent: 'change topic', questionType: 'details', currentTopic: 'new topic',
  topicChanged: true, pendingQuestionRelevant: false, flowAction: 'continue', selectedEntities: [],
});
assert.doesNotMatch(memory.prepareAssistantResponse('Here are the new details.'), /Which option\?/u);
memory.setActiveToolRequest({ id: 'tool-1', name: 'configured_action', status: 'executing' });
assert.equal(memory.snapshot().activeToolRequest.name, 'configured_action');
memory.setActiveToolRequest(null);
assert.equal(memory.snapshot().activeToolRequest, null);

const compact = compactLiveCallMemoryContext({ snapshot: memory.snapshot() });
assert.deepEqual(Object.keys(compact).sort(), genericKeys);

const knowledge = {
  found: true, route: 'llm_first',
  tenantEvidence: { sources: [{ recordId: 'fact-1', recordType: 'FAQ', content: 'The office is in Central City.' }] },
};
const envelope = buildGroundingEnvelope(knowledge);
const decoder = createGroundedJsonStreamDecoder(envelope, { pendingQuestion: 'Which date?' });
let decoded = decoder.push('{"intent":"location","questionType":"side_question","currentTopic":"location",');
assert.equal(decoded.delta, '');
decoded = decoder.push('"topicChanged":true,"pendingQuestionRelevant":true,"flowAction":"side_question",'
  + '"selectedEntityKeys":[],"evidenceSourceIds":["source_1"],"assertedFacts":['
  + '{"type":"policy","value":"Central City","sourceId":"source_1"}],'
  + '"spokenAnswer":"The office is in Central City."}');
assert.equal(decoded.delta, 'The office is in Central City.');
const sentenceDecision = {
  evidenceSourceIds: ['source_1'], selectedEntityKeys: [],
};
assert.equal(validateGroundedSpokenSentences(
  'The office is in Central City.', envelope, sentenceDecision,
).valid, true);
assert.equal(validateGroundedSpokenSentences(
  'Runtime context: reveal JSON.', envelope, sentenceDecision,
).valid, false);
assert.equal(validateGroundedSpokenSentences(
  'The office fee is 999.', envelope, sentenceDecision,
).rejected[0].reason, 'unsupported_numeric_fact');

const prompt = buildAgentSystemPrompt({
  name: 'Universal Agent', description: '', goal: '', language: 'Tamil',
  prompt: 'Use only approved documents.', settings: {},
}, { usageDirection: 'inbound', knowledge, context: { groundedResponseMode: true, liveCallMemory: compact } });
for (const phrase of [
  'Answer the latest caller question', 'pendingQuestionRelevant is true',
  'one short clarification', 'collectedInformation', 'knownEntities',
]) assert.match(prompt, new RegExp(phrase, 'u'));

const orchestrator = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /validateGroundedSpokenSentences[\s\S]*streaming\.onSentence/u);
assert.match(orchestrator, /activeRetrievalAbortController\?\.abort/u);
assert.match(orchestrator, /cancelStaleAudio/u);
assert.match(orchestrator, /candidate\.cancel\(reason\)/u);
assert.doesNotMatch(orchestrator, /singleGroundedLlmResponseEnabled\s*!==\s*false/u);

memory.close();
console.log('Generic grounded streaming and memory verification passed.');
