import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { normalizeLiveCallFrame } from '../src/voice/interaction/conversation-memory-state.js';
import { runParallelHybridRetrieval } from '../src/knowledge-bases/parallel-hybrid-retrieval.js';
import fs from 'node:fs';

const identity = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', callId: 'task-5' };
const memory = openGenericConversationState(identity, {});
memory.setPendingQuestion({ key: 'offer', text: 'Would you like the available options?', kind: 'conversation' });
memory.applyGroundedDecision({ flowAction: 'side_question', questionType: 'identity' });
const resumed = memory.prepareAssistantResponse('I am calling from the approved company.');
assert.match(resumed, /Would you like the available options\?/);
memory.observeAssistantResponse(resumed);
let snapshot = memory.snapshot();
assert.equal(snapshot.lastAnswer, resumed);
assert.deepEqual(snapshot.collectedInformation, {});

memory.setPendingQuestion({ key: 'old', text: 'Old pending question?', kind: 'conversation' });
memory.applyGroundedDecision({ flowAction: 'side_question', questionType: 'identity' });
memory.applyGroundedDecision({
  flowAction: 'direct_answer', questionType: 'details',
  pendingQuestionRelevant: false,
  selectedEntities: [{ id: 'new-item', key: 'new-item', name: 'New item' }],
});
const changedTopic = memory.prepareAssistantResponse('Here are the new item details.');
assert.doesNotMatch(changedTopic, /Old pending question/);

const persisted = normalizeLiveCallFrame(memory.snapshot());
assert.equal(persisted.lastAnswer, resumed);
assert.deepEqual(persisted.collectedInformation, {});
assert.ok(Array.isArray(persisted.recentTurns));

const startedAt = performance.now();
const bounded = await runParallelHybridRetrieval({
  immediate: () => ({ route: 'faq', found: true, content: 'approved' }),
  never: () => new Promise(() => {}),
}, { defaultDeadlineMs: 120 });
const elapsedMs = performance.now() - startedAt;
assert.equal(bounded.candidates.length, 1);
assert.ok(bounded.failures.some((failure) => failure.code === 'RETRIEVAL_CHANNEL_DEADLINE'));
assert.ok(elapsedMs < 300, `retrieval exceeded its bounded deadline: ${elapsedMs}ms`);

const controller = new AbortController();
const abortStartedAt = performance.now();
const abortedPromise = runParallelHybridRetrieval({
  never: () => new Promise(() => {}),
}, { defaultDeadlineMs: 500, signal: controller.signal });
controller.abort('barge_in');
const aborted = await abortedPromise;
assert.ok(aborted.failures.some((failure) => failure.code === 'RETRIEVAL_CHANNEL_ABORTED'));
assert.ok(performance.now() - abortStartedAt < 100);

const orchestratorSource = fs.readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestratorSource, /sttFinalizationMs/);
assert.match(orchestratorSource, /retrievalMs/);
assert.match(orchestratorSource, /rankingMs/);
assert.match(orchestratorSource, /llmFirstTokenMs/);
assert.match(orchestratorSource, /validationMs/);
assert.match(orchestratorSource, /ttsFirstAudioMs/);
assert.match(orchestratorSource, /firstAudioStatus/);
assert.match(orchestratorSource, /activeRetrievalAbortController\?\.abort/);

memory.close();
console.log('Production flow persistence, relevance, deadlines and cancellation verified.');
