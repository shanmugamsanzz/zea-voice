import assert from 'node:assert/strict';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import { createQdrantRetrievalRequest, QDRANT_RETRIEVAL_LIMITS } from '../src/voice/interaction/qdrant-retrieval-contract.js';

const cancellationSignal = new AbortController().signal;
const agents = [
  { tenantId: 'tenant-medical', agentId: 'agent-medical', prompt: 'Configured medical coordinator.',
    filename: 'medical.txt', text: 'Plan Amber costs 1200 and includes assessment.' },
  { tenantId: 'tenant-travel', agentId: 'agent-travel', prompt: 'Configured travel coordinator.',
    filename: 'travel.txt', text: 'Route Cedar costs 340 and departs at 09:00.' },
];

async function turn(agent, { question, history = [], pendingQuestion = null, state = {}, answer }) {
  let retrievalCalls = 0;
  let llmCalls = 0;
  const result = await runTemplateEngineProductionTurn({
    auth: { tenantId: agent.tenantId }, scope: { tenantId: agent.tenantId, agentId: agent.agentId },
    latestUtterance: question, conversationHistory: history, pendingQuestion,
    speechStatus: { transcriptFinal: true }, state, mainPrompt: agent.prompt,
    runtimeProfile: { agent: { id: agent.agentId, tenantId: agent.tenantId, prompt: agent.prompt } },
    authorizedWorkflowTools: [], informationFields: [], cancellationSignal,
  }, {
    retrieveQdrantKnowledge: async (input) => {
      retrievalCalls += 1;
      assert.equal(input.tenantId, agent.tenantId);
      assert.equal(input.agentId, agent.agentId);
      const request = createQdrantRetrievalRequest(input);
      return { request, chunks: answer.outcome === 'FACTUAL_ANSWER' ? [{
        id: `${agent.agentId}-chunk`, text: agent.text, score: 0.99, verified: true,
        source: { documentId: `${agent.agentId}-document`, filename: agent.filename, chunkIndex: 0 },
      }] : [], diagnostics: { queryEmbeddingCount: 1, qdrantSearchCount: 1,
        returnedChunkCount: answer.outcome === 'FACTUAL_ANSWER' ? 1 : 0,
        maximumChunks: QDRANT_RETRIEVAL_LIMITS.maximumChunks, tenantAgentFiltered: true } };
    },
    runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
    invokeStructuredLlm: async (request) => {
      llmCalls += 1;
      const prompt = request.messages[0].content;
      assert.match(prompt, new RegExp(agent.prompt.replace('.', '\\.')));
      assert.doesNotMatch(prompt, new RegExp(agents.find((entry) => entry !== agent).text));
      assert.match(request.messages.at(-1).content, new RegExp(question.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
      return { outputParsed: { workflowAction: null, ...answer } };
    },
    persistWorkflowState: async () => {},
  });
  assert.equal(retrievalCalls, 1);
  assert.equal(llmCalls, 1);
  assert.equal(result.llmInvocationCount, 1);
  assert.equal(result.diagnostics.retrieval.queryEmbeddingCount, 1);
  assert.equal(result.diagnostics.retrieval.qdrantSearchCount, 1);
  assert.equal(result.speech, answer.speech,
    'The replay must preserve the expected answer without substitution');
  return result;
}

for (const agent of agents) {
  const [subject, amount] = agent.text.match(/^(.*?) costs (\d+)/u).slice(1);
  const factual = await turn(agent, { question: `What does ${subject} cost?`, answer: {
    outcome: 'FACTUAL_ANSWER', speech: `${subject} costs ${amount}.`,
  } });
  assert.equal(factual.evidence[0].tenantId, agent.tenantId);
  assert.equal(factual.evidence[0].agentId, agent.agentId);

  await turn(agent, { question: 'Yes.', history: [
    { role: 'assistant', content: 'Would you like me to explain the options?' },
  ], pendingQuestion: { question: 'Would you like me to explain the options?' },
  answer: { outcome: 'CONVERSATIONAL_RESPONSE', speech: 'Here is the configured overview.' } });
  await turn(agent, { question: 'Actually, I meant the second one.', history: [
    { role: 'user', content: 'Tell me about the first one.' },
    { role: 'assistant', content: 'Which detail?' },
  ], pendingQuestion: { question: 'Which detail?' },
  answer: { outcome: 'CLARIFICATION', speech: 'Which detail about the second one?' } });
  await turn(agent, { question: 'Do you provide an undocumented service?', answer: {
    outcome: 'UNAVAILABLE', speech: 'I do not have verified information about that service.' } });
  await turn(agent, { question: 'Tell me about the name I just mispronounced.', history: [
    { role: 'assistant', content: 'I previously invented a name.' },
  ], answer: { outcome: 'CLARIFICATION', speech: 'Which configured option did you mean?' } });
  await turn(agent, { question: `¿Cuánto cuesta ${subject}?`, history: [
    { role: 'user', content: `Háblame de ${subject}.` },
  ], answer: { outcome: 'FACTUAL_ANSWER', speech: `${subject} cuesta ${amount}.` } });
  await turn(agent, { question: 'Please start the configured request.', answer: {
    outcome: 'CLARIFICATION', speech: 'Which configured option should I use for the request?',
  } });
  await turn(agent, { question: 'Cancel the pending request.', state: {
    workflow: { status: 'collecting' },
  }, answer: { outcome: 'WORKFLOW_CANCELLATION', speech: 'The pending request is cancelled.' } });
  await turn(agent, { question: 'Please continue.', history: [
    { role: 'assistant', content: 'The previous response was interrupted.', completion: 'interrupted' },
  ], answer: { outcome: 'CONVERSATIONAL_RESPONSE', speech: 'I will continue from the interrupted response.' } });
}

await assert.rejects(() => runTemplateEngineProductionTurn({
  auth: { tenantId: agents[0].tenantId },
  scope: { tenantId: agents[1].tenantId, agentId: agents[1].agentId },
  latestUtterance: 'Cross-tenant request', cancellationSignal,
}, { invokeStructuredLlm: async () => ({}), retrieveQdrantKnowledge: async () => ({}),
  runQdrantUniversalTurn: async () => ({}) }),
{ code: 'TEMPLATE_ENGINE_RETRIEVAL_SCOPE_MISMATCH' });

console.log(JSON.stringify({ agents: agents.length, scenariosPerAgent: 9,
  multilingual: true, followUps: true, missingKnowledge: true, booking: true,
  correction: true, cancellation: true, interruption: true, expectedAnswersPreserved: true,
  oneEmbedding: true, oneSearch: true, maximumLlmCalls: 1, tenantIsolation: true }));
