import assert from 'node:assert/strict';
import { runAgentQdrantGroundedTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import { createQdrantRetrievalRequest } from '../src/voice/interaction/qdrant-retrieval-contract.js';
import { runTemplateEngineProductionTurn } from '../src/voice/interaction/template-engine-production-runtime.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const cancellationSignal = new AbortController().signal;
const request = createQdrantRetrievalRequest({
  tenantId,
  agentId,
  question: 'Gold package price?',
  previousContext: [{ role: 'user', content: 'Tell me about full body checkups.' }],
  cancellationSignal,
});
const chunks = Object.freeze([Object.freeze({
  id: 'point-1',
  text: 'The Gold package price is 4950 rupees.',
  score: 0.95,
  verified: true,
  source: Object.freeze({
    documentId: '33333333-3333-4333-8333-333333333333',
    filename: 'packages.txt',
    chunkIndex: 0,
    metadata: Object.freeze({}),
  }),
})]);
const retrieval = Object.freeze({
  request,
  searchText: 'Gold package price?',
  embeddingModel: 'intfloat/multilingual-e5-base',
  chunks,
  diagnostics: Object.freeze({ queryEmbeddingCount: 1, qdrantSearchCount: 1,
    returnedChunkCount: 1, maximumChunks: 3, tenantAgentFiltered: true }),
});

let llmCalls = 0;
let llmRequest = null;
const answered = await runAgentQdrantGroundedTurn({
  retrieval,
  tenantId,
  agentId,
  currentQuestion: 'Gold package price?',
  previousContext: request.previousContext,
  cancellationSignal,
  agentPrompt: 'Answer naturally and briefly.',
  language: 'ta-IN',
  maximumSpeechCharacters: 300,
}, {
  invokeStructuredLlm: async (input) => {
    llmCalls += 1;
    llmRequest = input;
    return { answer: {
      decision: 'RESPONSE',
      speech: 'Gold package price 4950 rupees.',
      evidenceIds: ['point-1'],
    } };
  },
});

assert.equal(llmCalls, 1);
assert.equal(llmRequest.responseFormat.name, 'agent_qdrant_grounded_answer');
assert.match(llmRequest.messages[0].content, /Answer naturally and briefly/u);
assert.match(llmRequest.messages[0].content, /Tell me about full body checkups/u);
assert.match(llmRequest.messages[0].content, /Gold package price is 4950/u);
assert.equal(answered.decision.decision, 'RESPONSE');
assert.deepEqual(answered.evidenceIds, ['point-1']);
assert.equal(answered.evidence[0].verified, true);

let noMatchCalls = 0;
const noMatch = await runAgentQdrantGroundedTurn({
  retrieval: { ...retrieval, chunks: Object.freeze([]) },
  tenantId,
  agentId,
  currentQuestion: 'Do you send this through WhatsApp?',
  previousContext: request.previousContext,
  cancellationSignal,
  agentPrompt: 'Respond in the caller language.',
  language: 'ta-IN',
  maximumSpeechCharacters: 300,
}, {
  invokeStructuredLlm: async () => {
    noMatchCalls += 1;
    return { answer: {
      decision: 'NO_MATCH',
      speech: 'அந்த தகவல் என்னிடம் இல்லைங்க. வேறு விதமாக உதவட்டுமா?',
      evidenceIds: [],
    } };
  },
});
assert.equal(noMatchCalls, 1);
assert.equal(noMatch.decision.decision, 'NO_MATCH');
assert.ok(noMatch.speech.length > 0);

let productionLlmCalls = 0;
let legacyRetrievalCalls = 0;
const stageTimings = {};
const productionResult = await runTemplateEngineProductionTurn({
  auth: { tenantId },
  scope: { tenantId, agentId, publications: [] },
  callId: 'qdrant-production-turn',
  usageDirection: 'inbound',
  language: 'en',
  mainPrompt: 'Answer naturally and briefly.',
  maximumSpeechCharacters: 300,
  latestUtterance: 'Gold package price?',
  conversationHistory: request.previousContext,
  state: {},
  runtimeProfile: { agent: { id: agentId, tenantId, name: 'Test Agent' } },
  assignedTools: [],
  informationFields: [],
  cancellationSignal,
}, {
  invokeStructuredLlm: async () => {
    productionLlmCalls += 1;
    return { answer: {
      decision: 'RESPONSE', speech: 'Gold package price is 4950 rupees.',
      evidenceIds: ['point-1'],
    } };
  },
  loadWorkflowContext: async () => ({
    scope: { tenantId, agentId, publications: [] },
    publishedWorkflows: [],
    publishedConversationGuidance: [],
  }),
  retrieveQdrantKnowledge: async () => retrieval,
  runQdrantGroundedTurn: runAgentQdrantGroundedTurn,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {},
  onStageTiming: (timing) => {
    const stage = stageTimings[timing.stage] ??= { operations: {} };
    const operation = stage.operations[timing.operation] ??= { calls: 0 };
    operation.calls += 1;
  },
});
assert.equal(productionLlmCalls, 1);
assert.equal(legacyRetrievalCalls, 0);
assert.equal(productionResult.llmInvocationCount, 1);
assert.equal(productionResult.diagnostics.architecture.path, 'qdrant_contextual_one_llm');
assert.equal(productionResult.diagnostics.architecture.enforced, true);
assert.deepEqual(productionResult.diagnostics.architecture.retrieval, {
  enforced: true,
  queryEmbeddingCount: 1,
  qdrantSearchCount: 1,
  returnedChunkCount: 1,
  maximumChunks: 3,
  tenantAgentFiltered: true,
});
assert.equal(stageTimings.retrieval.operations.retrieval.calls, 1);
assert.equal(stageTimings.generation.operations.answer_generation.calls, 1);

let missingInformationLlmCalls = 0;
const missingInformationResult = await runTemplateEngineProductionTurn({
  auth: { tenantId },
  scope: { tenantId, agentId, publications: [] },
  callId: 'qdrant-production-no-match-turn',
  usageDirection: 'inbound',
  language: 'en',
  mainPrompt: 'Answer naturally and briefly.',
  maximumSpeechCharacters: 300,
  latestUtterance: 'Do you provide helicopter transport?',
  conversationHistory: request.previousContext,
  state: {},
  runtimeProfile: { agent: { id: agentId, tenantId, name: 'Test Agent' } },
  assignedTools: [],
  informationFields: [],
  cancellationSignal,
}, {
  invokeStructuredLlm: async () => {
    missingInformationLlmCalls += 1;
    return { answer: {
      decision: 'NO_MATCH',
      speech: 'I do not have verified information about that service. How else can I help?',
      evidenceIds: [],
    } };
  },
  loadWorkflowContext: async () => ({
    scope: { tenantId, agentId, publications: [] },
    publishedWorkflows: [],
    publishedConversationGuidance: [],
  }),
  retrieveQdrantKnowledge: async () => ({
    ...retrieval,
    chunks: Object.freeze([]),
    diagnostics: Object.freeze({
      ...retrieval.diagnostics,
      returnedChunkCount: 0,
    }),
  }),
  runQdrantGroundedTurn: runAgentQdrantGroundedTurn,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {},
});
assert.equal(missingInformationLlmCalls, 1);
assert.equal(missingInformationResult.llmInvocationCount, 1);
assert.equal(missingInformationResult.decision.decision, 'NO_MATCH');
assert.equal(missingInformationResult.diagnostics.architecture.enforced, true);

console.log(JSON.stringify({
  pipeline: 'context-plus-qdrant-plus-one-grounded-llm',
  factualLlmCalls: llmCalls,
  unavailableLlmCalls: noMatchCalls,
  productionUnavailableLlmCalls: missingInformationLlmCalls,
  routingLlmCalls: 0,
  reviewLlmCalls: 0,
  naturalRecovery: true,
  productionRuntimeConnected: true,
}, null, 2));
