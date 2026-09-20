import assert from 'node:assert/strict';
import { buildUniversalTurnContext } from '../src/voice/interaction/universal-turn-context.js';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import { createQdrantRetrievalRequest, QDRANT_RETRIEVAL_LIMITS } from '../src/voice/interaction/qdrant-retrieval-contract.js';

const history = [
  { role: 'assistant', content: 'Welcome. How can I help?' },
  { role: 'user', content: 'Use the first option.' },
  { role: 'user', content: 'Actually use the second option.' },
  { role: 'assistant', content: 'Which date?' },
  { role: 'user', content: 'Tomorrow' },
];
const pending = { key: 'date', question: 'Which date?', kind: 'field' };
const context = buildUniversalTurnContext({ currentQuestion: 'Tomorrow',
  conversationHistory: history, pendingQuestion: pending,
  speechStatus: { transcriptFinal: true }, conversationContextMode: 'last_n_turns',
  conversationContextTurns: 2 });
assert.deepEqual(context.recentConversation.map(({ content }) => content),
  history.slice(1, -1).map(({ content }) => content));
assert.equal(context.pendingQuestion.question, 'Which date?');
assert.equal(context.currentSpeech.semanticCompletion, 'unknown');
assert.equal(context.currentSpeech.transcriptFinal, true);
assert.equal(history.length, 5);

const interrupted = buildUniversalTurnContext({ currentQuestion: 'Continue', pendingQuestion: pending,
  conversationHistory: [
    { role: 'user', content: 'One moment', isFinal: false },
    { role: 'assistant', content: 'Confirm the', interrupted: true },
    { role: 'assistant', content: 'unplayed full confirmation', audible: false },
  ] });
assert.equal(interrupted.recentConversation.length, 0);
assert.equal(interrupted.lastAssistantResponse.completion, 'interrupted');
assert.equal(interrupted.pendingQuestion, null);
assert.equal(buildUniversalTurnContext({ currentQuestion: 'Repeat', conversationHistory: [
  { role: 'user', content: 'Repeat' }, { role: 'assistant', content: 'Which part?' },
  { role: 'user', content: 'Repeat' },
] }).recentConversation[0].content, 'Repeat');
const bounded = buildUniversalTurnContext({ conversationHistory: Array.from({ length: 50 },
  (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${'x'.repeat(900)}` })),
conversationContextMode: 'last_n_turns', conversationContextTurns: 2 });
assert.equal(bounded.recentConversation.length, 4);
assert.ok(bounded.recentConversation[0].content.startsWith('46 '));
assert.ok(bounded.recentConversation.at(-1).content.startsWith('49 '));
const fullCurrentCall = buildUniversalTurnContext({ conversationHistory: history,
  conversationContextMode: 'full_current_call', conversationContextTurns: 1 });
assert.equal(fullCurrentCall.recentConversation.length, history.length,
  'Full-current-call mode must not be reduced by the recent-turn setting');

let searches = 0;
let calls = 0;
const result = await runTemplateEngineProductionTurn({
  auth: { tenantId: 'tenant-context' }, scope: { tenantId: 'tenant-context', agentId: 'agent-context' },
  latestUtterance: 'Tomorrow', conversationHistory: history, pendingQuestion: pending,
  speechStatus: { transcriptFinal: true },
  runtimeProfile: { agent: { settings: {
    conversationContextMode: 'last_n_turns', conversationContextTurns: 2,
  } } },
  state: { activeWorkflowId: 'workflow-context', collectedToolFields: { option: 'second' },
    confirmationStatus: 'pending_fields' },
  mainPrompt: 'Follow configured instructions.', cancellationSignal: new AbortController().signal,
}, {
  retrieveQdrantKnowledge: async (input) => {
    searches += 1;
    assert.equal(input.previousContext[0].content, history[1].content);
    assert.equal(input.previousContext.at(-1).content, 'Which date?');
    return { request: createQdrantRetrievalRequest(input), chunks: [],
      diagnostics: { queryEmbeddingCount: 1, qdrantSearchCount: 1,
        returnedChunkCount: 0, maximumChunks: QDRANT_RETRIEVAL_LIMITS.maximumChunks, tenantAgentFiltered: true } };
  },
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  invokeStructuredLlm: async (request) => {
    calls += 1;
    const prompt = request.messages[0].content;
    const turn = JSON.parse(prompt.split('<turn_context>\n')[1].split('\n</turn_context>')[0]);
    const workflow = JSON.parse(prompt.split('<current_workflow_state>\n')[1]
      .split('\n</current_workflow_state>')[0]);
    assert.deepEqual(turn, {
      recentConversation: context.recentConversation,
      pendingQuestion: context.pendingQuestion,
      currentSpeech: context.currentSpeech,
      latestAssistantDelivery: null,
    });
    assert.equal(workflow.activeWorkflowId, 'workflow-context');
    assert.equal(workflow.collectedToolFields.option, 'second');
    assert.equal(request.messages.at(-1).content, 'Tomorrow');
    return { outputParsed: { outcome: 'CLARIFICATION', speech: 'Which time?',
      evidenceIds: [], workflowAction: null } };
  },
});
assert.equal(calls, 1);
assert.equal(searches, 1);
assert.equal(result.state.activeWorkflowId, 'workflow-context');
console.log('Universal turn context: passed');
