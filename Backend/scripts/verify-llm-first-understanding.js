import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAgentSystemPrompt } from '../src/agents/agent-runtime.service.js';
import {
  buildGroundingEnvelope,
  validateGroundedLlmResponse,
} from '../src/voice/interaction/grounded-llm-response.js';
import { openLiveCallMemory } from '../src/voice/interaction/live-call-memory.js';

const orchestrator = await readFile(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.doesNotMatch(orchestrator, /import\s*\{?\s*detectConversationIntent/u);
assert.doesNotMatch(orchestrator, /routeKnowledgeQuery/u);
assert.doesNotMatch(orchestrator, /singleGroundedLlmResponseEnabled\s*!==\s*false/u);
assert.match(orchestrator, /Promise\.all\(\[/u);
assert.match(orchestrator, /loadPublishedKnowledgeMap/u);
assert.match(orchestrator, /retrieveTenantEvidence/u);
assert.match(orchestrator, /route:\s*'llm_first'/u);

const knowledge = {
  found: true,
  route: 'llm_first',
  content: 'The office is in Central City.',
  source: { recordId: 'fact-1' },
  compactKnowledgeMap: {
    records: [{
      id: 'fact-1', type: 'KNOWLEDGE_CHUNK', label: 'Office location',
      summary: 'The office is in Central City.', language: 'en', metadata: {},
    }],
    maps: [{
      knowledgeBaseId: 'kb-1', publicationRevision: 3,
      records: [{ id: 'fact-1', type: 'KNOWLEDGE_CHUNK', label: 'Office location', summary: 'The office is in Central City.' }],
    }],
  },
};
const prompt = buildAgentSystemPrompt({
  name: 'Universal Agent', description: '', goal: 'Answer correctly',
  language: 'English', prompt: 'Use only published evidence.', settings: {},
}, {
  usageDirection: 'inbound', knowledge, maxPromptChars: 12_000,
  context: {
    groundedResponseMode: true,
    liveCallMemory: {
      currentTopic: 'service options',
      selectedCatalogItem: { key: 'service-a', name: 'Service A' },
      candidateItems: [{ key: 'service-b', name: 'Service B' }],
      pendingQuestion: 'Which option do you prefer?',
      collectedData: { customerName: 'Example' },
      lastAnswer: 'These are the available options.',
    },
  },
});
for (const required of [
  'latest caller question first', 'currentTopic', 'pendingQuestion', 'collectedData',
  'lastAnswer', 'publishedKnowledgeMap', 'topicChanged', 'pendingQuestionRelevant',
]) assert.match(prompt, new RegExp(required, 'u'));

const envelope = buildGroundingEnvelope(knowledge);
const decision = validateGroundedLlmResponse(JSON.stringify({
  intent: 'ask caller origin',
  questionType: 'side_question',
  currentTopic: 'office location',
  topicChanged: true,
  pendingQuestionRelevant: false,
  flowAction: 'side_question',
  selectedEntityKeys: [],
  evidenceSourceIds: ['source_1'],
  assertedFacts: [{ type: 'policy', value: 'Central City', sourceId: 'source_1' }],
  spokenAnswer: 'The office is in Central City.',
}), envelope, { pendingQuestion: 'Which option do you prefer?' });
assert.equal(decision.valid, true);
assert.equal(decision.topicChanged, true);
assert.equal(decision.pendingQuestionRelevant, false);

const memory = openLiveCallMemory({
  tenantId: 'tenant-1', workspaceId: 'workspace-1', agentId: 'agent-1', callId: 'call-1',
}, {}, Date.now(), {
  currentTopic: 'service options',
  pendingQuestion: { key: 'preferredOption', text: 'Which option do you prefer?', kind: 'field' },
});
memory.applyGroundedDecision(decision);
assert.equal(memory.snapshot().currentTopic, 'office location');
assert.equal(memory.snapshot().pendingQuestion, null);
memory.close();

console.log('LLM-first understanding verification passed.');
