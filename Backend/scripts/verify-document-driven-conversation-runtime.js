import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { isolatedRetrievalQueries } from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { evidenceBelongsToRuntime } from '../src/voice/interaction/grounded-decision-security.js';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { rankRelevantHydratedEvidence } from '../src/voice/interaction/grounded-claim-validator.js';
import {
  approvedHydratedEvidenceFallback,
} from '../src/voice/realtime-conversation-orchestrator.js';

const scope = Object.freeze({
  tenantId: 'tenant-a', agentId: 'agent-a',
  publicationRevisions: [{ knowledgeBaseId: 'kb-a', publicationRevision: 7 }],
});

const industries = Object.freeze([
  { industry: 'healthcare', language: 'ta', acknowledgement: 'சரி, சொல்லுங்கள்', overview: 'Approved screening options.' },
  { industry: 'property', language: 'ta', acknowledgement: 'ஆமாம், சொல்லுங்க', overview: 'Approved property options.' },
  { industry: 'education', language: 'en', acknowledgement: 'Yes, please continue', overview: 'Approved course options.' },
  { industry: 'insurance', language: 'en', acknowledgement: 'Okay, tell me', overview: 'Approved policy options.' },
  { industry: 'retail', language: 'ta', acknowledgement: 'seri explain pannunga', overview: 'Approved product options.' },
]);

for (const [index, fixture] of industries.entries()) {
  const message = {
    id: `message-${index}`, recordId: `message-${index}`, recordType: 'CONVERSATION_NODE',
    tenantId: scope.tenantId, agentId: scope.agentId, knowledgeBaseId: 'kb-a', publicationRevision: 7,
    callerFacing: true, content: fixture.overview, score: 0.95, rank: 1,
    authoritativeData: { nodeType: 'message' },
  };
  const envelope = buildGroundingEnvelope({
    found: true, tenantEvidence: { sources: [message], guidanceEvidence: [] }, matches: [],
  }, { includePublishedMap: false, maximumSources: 5 });
  assert.equal(envelope.sources[0].content, fixture.overview, `${fixture.industry}: exact overview response`);
  assert.equal(evidenceBelongsToRuntime(message, scope), true, `${fixture.industry}: evidence scope`);
  const queries = isolatedRetrievalQueries({
    query: fixture.acknowledgement,
    currentTopic: `stale-${fixture.industry}`,
    lastAnswer: 'Previous answer must not replace the latest turn.',
  });
  assert.equal(queries.primary, fixture.acknowledgement, `${fixture.industry}: latest utterance remains primary`);
}

const internalGuidance = {
  id: 'internal-guidance', recordId: 'internal-guidance', recordType: 'CONVERSATION_NODE',
  callerFacing: false, content: 'Internal operational instruction.', score: 0.99, rank: 1,
  authoritativeData: { nodeType: 'guidance' },
};
const safeMessage = {
  id: 'safe-message', recordId: 'safe-message', recordType: 'CONVERSATION_NODE',
  callerFacing: true, content: 'Approved caller response.', score: 0.9, rank: 2,
  authoritativeData: { nodeType: 'message' },
};
const guidanceEnvelope = buildGroundingEnvelope({
  found: true,
  tenantEvidence: { sources: [safeMessage], guidanceEvidence: [internalGuidance] },
}, { includePublishedMap: false });
assert.deepEqual(guidanceEnvelope.sources.map((source) => source.content), ['Approved caller response.']);

const fullCatalog = {
  id: 'catalog-1', recordId: 'catalog-1', recordType: 'CATALOG_ITEM',
  tenantId: scope.tenantId, agentId: scope.agentId, knowledgeBaseId: 'kb-a', publicationRevision: 7,
  callerFacing: true, rank: 1, score: 0.96,
  content: 'Complete approved item record.',
  authoritativeData: {
    itemKey: 'item-one', name: 'Item One', price: 125, currency: 'USD',
    attributes: [{ key: 'features', value: ['Feature A', 'Feature B'] }],
    relationships: { requires: ['item-two'] }, selectionRules: { selectable: true },
  },
};
const catalogEnvelope = buildGroundingEnvelope({
  found: true, tenantEvidence: { sources: [fullCatalog], guidanceEvidence: [] },
}, { includePublishedMap: false });
assert.deepEqual(catalogEnvelope.sources[0].authoritativeData, fullCatalog.authoritativeData);

const memory = openGenericConversationState({
  tenantId: 'tenant-a', workspaceId: 'workspace-a', agentId: 'agent-a', callId: 'call-a',
}, {
  language: 'Tamil', recentTurns: 8,
  conversationMemoryFields: [
    { key: 'reference', label: 'Reference', type: 'text', required: false, question: 'What is the reference?' },
  ],
}, Date.now(), {
  pendingQuestion: { text: 'Approved pending question?', kind: 'conversation' },
});
const turnOne = memory.beginTurn('turn-1');
memory.append({ role: 'user', content: 'Tell me about Item One' }, { turnToken: turnOne });
memory.applyGroundedDecision({
  stateUpdate: {
    currentTopic: 'Item One',
    knownEntities: [{ key: 'item-one', name: 'Item One', sourceId: 'source_1' }],
    collectedInformation: { reference: 'ABC-1' },
  },
  pendingQuestionRelevant: true,
}, { turnToken: turnOne });
memory.observeAssistantResponse('Approved item details.', { turnToken: turnOne });
let snapshot = memory.snapshot();
assert.equal(snapshot.currentTopic, 'Item One');
assert.equal(snapshot.knownEntities[0].key, 'item-one');
assert.equal(snapshot.collectedInformation.reference, 'ABC-1');
assert.equal(snapshot.recentTurns.at(-1).content, 'Tell me about Item One');
assert.equal(snapshot.lastAnswer, 'Approved item details.');

const turnTwo = memory.beginTurn('turn-2');
memory.applyGroundedDecision({
  flowAction: 'side_question', pendingQuestionRelevant: true,
  stateUpdate: { currentTopic: 'Side question' },
}, { turnToken: turnTwo });
assert.match(memory.prepareAssistantResponse('Approved side answer.', { resumePending: true }), /Approved pending question\?/u);
assert.equal(memory.snapshot().knownEntities[0].key, 'item-one');

const turnThree = memory.beginTurn('turn-3');
memory.applyGroundedDecision({
  pendingQuestionRelevant: false, stateUpdate: { currentTopic: 'New topic' },
}, { turnToken: turnThree });
assert.equal(memory.snapshot().pendingQuestion, null);
memory.cancelTurn(turnThree);
const stale = memory.applyGroundedDecision({ stateUpdate: { currentTopic: 'Stale topic' } }, { turnToken: turnThree });
assert.equal(stale.stale, true);
assert.equal(memory.snapshot().currentTopic, 'New topic');
memory.close();

const unrelated = {
  ...safeMessage,
  id: 'unrelated', recordId: 'unrelated', recordType: 'FAQ',
  content: 'Completely unrelated approved fact.', authoritativeData: { question: 'Different question' },
};
const unrelatedEnvelope = {
  found: true,
  sources: [{ id: 'source_1', recordId: unrelated.recordId, recordType: unrelated.recordType, content: unrelated.content }],
};
assert.equal(rankRelevantHydratedEvidence('latest request', unrelatedEnvelope, [unrelated]).length, 0);
const profile = { agent: { language: 'English', settings: { noResponseMessage: 'Configured safe response.' } } };
assert.equal(
  approvedHydratedEvidenceFallback('latest request', unrelatedEnvelope, [unrelated], profile).text,
  'Configured safe response.',
);

assert.equal(evidenceBelongsToRuntime({ ...fullCatalog, tenantId: 'tenant-b' }, scope), false);
assert.equal(evidenceBelongsToRuntime({ ...fullCatalog, publicationRevision: 6 }, scope), false);

const orchestratorSource = await readFile(new URL(
  '../src/voice/realtime-conversation-orchestrator.js', import.meta.url,
), 'utf8');
assert.match(orchestratorSource, /settleWithin\(/u, 'Retrieval/provider operations must remain bounded');
assert.match(orchestratorSource, /caller_barge_in/u, 'Barge-in must cancel stale work');

console.log(JSON.stringify({
  task: 'document-driven-conversation-runtime', passed: true,
  industries: industries.map((fixture) => fixture.industry),
  languages: ['Tamil', 'Tanglish', 'English'],
  latestTurnFirst: true, exactCallerResponses: true, completeCatalogHydration: true,
  selectedEntityContinuation: true, interruptionIsolation: true,
  safeFallbackOnly: true, tenantRevisionIsolation: true, boundedRuntime: true,
}));
