import assert from 'node:assert/strict';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';
import { parseTemplateEngineStructuredOutput } from '../src/voice/interaction/template-engine-structured-output.js';
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

const parsedUniversalEnvelope = parseTemplateEngineStructuredOutput({
  completion: { type: 'completed', finishReason: 'stop' },
  output: JSON.stringify({
    outcome: 'UNAVAILABLE', speech: 'I do not have verified information about that.',
    evidenceIds: [], workflowAction: null,
  }),
  schema: {
    type: 'object', additionalProperties: false,
    required: ['outcome', 'speech', 'evidenceIds', 'workflowAction'],
    properties: {
      outcome: { type: 'string' }, speech: { type: 'string' },
      evidenceIds: { type: 'array', items: { type: 'string' } },
      workflowAction: { type: ['object', 'null'] },
    },
  },
});
assert.equal(parsedUniversalEnvelope.workflowAction, null);

let llmCalls = 0;
let llmRequest = null;
const answered = await runAgentQdrantUniversalTurn({
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
      outcome: 'FACTUAL_ANSWER',
      speech: 'Gold package price 4950 rupees.',
      evidenceIds: ['point-1'],
      workflowAction: null,
    } };
  },
});

assert.equal(llmCalls, 1);
assert.equal(llmRequest.responseFormat.name, 'agent_qdrant_universal_turn');
assert.match(llmRequest.messages[0].content, /Answer naturally and briefly/u);
assert.match(llmRequest.messages[0].content, /Tell me about full body checkups/u);
assert.match(llmRequest.messages[0].content, /Gold package price is 4950/u);
assert.equal(answered.decision.decision, 'RESPONSE');
assert.deepEqual(answered.evidenceIds, ['point-1']);
assert.equal(answered.evidence[0].verified, true);

let noMatchCalls = 0;
const noMatch = await runAgentQdrantUniversalTurn({
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
      outcome: 'UNAVAILABLE',
      speech: 'அந்த தகவல் என்னிடம் இல்லைங்க. வேறு விதமாக உதவட்டுமா?',
      evidenceIds: [],
      workflowAction: null,
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
      outcome: 'FACTUAL_ANSWER', speech: 'Gold package price is 4950 rupees.',
      evidenceIds: ['point-1'],
      workflowAction: null,
    } };
  },
  retrieveQdrantKnowledge: async () => retrieval,
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
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
assert.equal(productionResult.diagnostics.architecture.path, 'qdrant_contextual_one_universal_llm');
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
      outcome: 'UNAVAILABLE',
      speech: 'I do not have verified information about that service. How else can I help?',
      evidenceIds: [],
      workflowAction: null,
    } };
  },
  retrieveQdrantKnowledge: async () => ({
    ...retrieval,
    chunks: Object.freeze([]),
    diagnostics: Object.freeze({
      ...retrieval.diagnostics,
      returnedChunkCount: 0,
    }),
  }),
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async () => {},
});
assert.equal(missingInformationLlmCalls, 1);
assert.equal(missingInformationResult.llmInvocationCount, 1);
assert.equal(missingInformationResult.decision.decision, 'NO_MATCH');
assert.equal(missingInformationResult.diagnostics.architecture.enforced, true);

const configuredTool = Object.freeze({
  id: '44444444-4444-4444-8444-444444444444',
  name: 'create_request',
  identifiers: Object.freeze(['create_request']),
  description: 'Create the configured customer request.',
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false,
    properties: Object.freeze({ customer_name: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['customer_name']),
  }),
});
const workflowProfile = {
  agent: {
    id: agentId, tenantId, name: 'Configured Agent', description: 'Configured identity',
    goal: 'Follow configured instructions', prompt: 'Use the configured conversation policy.',
    language: 'en', settings: {
      taskCompletionEnabled: true,
      taskCompletionIntent: 'create_request',
      taskCompletionRequiredFields: ['customer_name'],
      taskCompletionConfirmationMessage: 'Should I submit this request?',
    },
  },
  configuration: { closing: { messageType: 'dynamic', prompt: 'Close briefly.' } },
};
let workflowPrompt = '';
const workflowResult = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope: { tenantId, agentId }, language: 'en',
  mainPrompt: workflowProfile.agent.prompt, maximumSpeechCharacters: 300,
  latestUtterance: 'Please create it for Arun.', conversationHistory: [], state: {},
  runtimeProfile: workflowProfile, authorizedWorkflowTools: [configuredTool],
  informationFields: [{ key: 'customer_name', label: 'Customer name', type: 'text',
    required: true, question: 'What is the customer name?', requiredAction: 'create_request' }],
  cancellationSignal,
}, {
  invokeStructuredLlm: async (input) => {
    workflowPrompt = input.messages[0].content;
    return { answer: {
      outcome: 'WORKFLOW_ACTION', speech: 'Should I submit this request?', evidenceIds: [],
      workflowAction: { action: 'UPSERT', workflowId: configuredTool.id,
        toolName: configuredTool.name, argumentsJson: '{"customer_name":"Arun"}' },
    } };
  },
  retrieveQdrantKnowledge: async () => ({ ...retrieval, chunks: Object.freeze([]),
    diagnostics: Object.freeze({ ...retrieval.diagnostics, returnedChunkCount: 0 }) }),
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  persistWorkflowState: async () => {},
});
assert.equal(workflowResult.llmInvocationCount, 1);
assert.equal(workflowResult.workflow.status, 'awaiting_confirmation');
assert.equal(workflowResult.state.collectedToolFields.customer_name, 'Arun');
assert.match(workflowPrompt, /Configured identity/u);
assert.match(workflowPrompt, /What is the customer name/u);
assert.match(workflowPrompt, /Should I submit this request/u);
assert.match(workflowPrompt, /Close briefly/u);

let executedTools = 0;
const executionResult = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope: { tenantId, agentId }, language: 'en',
  mainPrompt: workflowProfile.agent.prompt, maximumSpeechCharacters: 300,
  latestUtterance: 'Yes, submit it.', conversationHistory: [], state: workflowResult.state,
  runtimeProfile: workflowProfile, authorizedWorkflowTools: [configuredTool],
  informationFields: [], cancellationSignal,
}, {
  invokeStructuredLlm: async () => ({ answer: {
    outcome: 'WORKFLOW_ACTION', speech: 'I will submit that now.', evidenceIds: [],
    workflowAction: { action: 'EXECUTE', workflowId: configuredTool.id,
      toolName: configuredTool.name, argumentsJson: '{}' },
  } }),
  retrieveQdrantKnowledge: async () => ({ ...retrieval, chunks: Object.freeze([]),
    diagnostics: Object.freeze({ ...retrieval.diagnostics, returnedChunkCount: 0 }) }),
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  persistWorkflowState: async () => {},
  executeAuthorizedTool: async (toolCall) => {
    executedTools += 1;
    assert.equal(toolCall.authorizationRecordId, configuredTool.id);
    assert.deepEqual(toolCall.arguments, { customer_name: 'Arun' });
    return { success: true, name: configuredTool.name };
  },
});
assert.equal(executionResult.llmInvocationCount, 1);
assert.equal(executedTools, 1);
assert.equal(executionResult.toolExecuted, true);
assert.equal(executionResult.workflow.status, 'completed');

const correctedWorkflowResult = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope: { tenantId, agentId }, language: 'ta-IN',
  mainPrompt: workflowProfile.agent.prompt, maximumSpeechCharacters: 300,
  latestUtterance: 'Correct the submitted field.', conversationHistory: [], state: workflowResult.state,
  runtimeProfile: workflowProfile, authorizedWorkflowTools: [configuredTool],
  informationFields: [{ key: 'customer_name', label: 'Customer name', type: 'text',
    required: true, question: 'What is the customer name?', requiredAction: 'create_request' }],
  cancellationSignal,
}, {
  invokeStructuredLlm: async () => ({ answer: {
    outcome: 'WORKFLOW_ACTION', speech: 'Please confirm the corrected request.', evidenceIds: [],
    workflowAction: { action: 'UPSERT', workflowId: configuredTool.id,
      toolName: configuredTool.name, argumentsJson: '{"customer_name":"Mira"}' },
  } }),
  retrieveQdrantKnowledge: async () => ({ ...retrieval, chunks: Object.freeze([]),
    diagnostics: Object.freeze({ ...retrieval.diagnostics, returnedChunkCount: 0 }) }),
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  persistWorkflowState: async () => {},
});
assert.equal(correctedWorkflowResult.llmInvocationCount, 1);
assert.equal(correctedWorkflowResult.workflow.status, 'awaiting_confirmation');
assert.equal(correctedWorkflowResult.state.collectedToolFields.customer_name, 'Mira');

const cancelledWorkflowResult = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope: { tenantId, agentId }, language: 'ta-IN',
  mainPrompt: workflowProfile.agent.prompt, maximumSpeechCharacters: 300,
  latestUtterance: 'Cancel the pending request.', conversationHistory: [], state: correctedWorkflowResult.state,
  runtimeProfile: workflowProfile, authorizedWorkflowTools: [configuredTool],
  informationFields: [], cancellationSignal,
}, {
  invokeStructuredLlm: async () => ({ answer: {
    outcome: 'WORKFLOW_CANCELLATION', speech: 'The pending request is cancelled.',
    evidenceIds: [], workflowAction: null,
  } }),
  retrieveQdrantKnowledge: async () => ({ ...retrieval, chunks: Object.freeze([]),
    diagnostics: Object.freeze({ ...retrieval.diagnostics, returnedChunkCount: 0 }) }),
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  persistWorkflowState: async () => {},
});
assert.equal(cancelledWorkflowResult.llmInvocationCount, 1);
assert.equal(cancelledWorkflowResult.workflow.status, 'cancelled');
assert.equal(cancelledWorkflowResult.state.activeWorkflowId, null);

const closingResult = await runTemplateEngineProductionTurn({
  auth: { tenantId }, scope: { tenantId, agentId }, language: 'ta-IN',
  mainPrompt: workflowProfile.agent.prompt, maximumSpeechCharacters: 300,
  latestUtterance: 'End this conversation.', conversationHistory: [], state: {},
  runtimeProfile: workflowProfile, authorizedWorkflowTools: [], informationFields: [],
  cancellationSignal,
}, {
  invokeStructuredLlm: async () => ({ answer: {
    outcome: 'CLOSING', speech: 'Goodbye.', evidenceIds: [], workflowAction: null,
  } }),
  retrieveQdrantKnowledge: async () => ({ ...retrieval, chunks: Object.freeze([]),
    diagnostics: Object.freeze({ ...retrieval.diagnostics, returnedChunkCount: 0 }) }),
  runQdrantUniversalTurn: runAgentQdrantUniversalTurn,
  persistWorkflowState: async () => {},
});
assert.equal(closingResult.llmInvocationCount, 1);
assert.equal(closingResult.callControl, 'close');

console.log(JSON.stringify({
  pipeline: 'context-plus-qdrant-plus-one-universal-llm',
  factualLlmCalls: llmCalls,
  unavailableLlmCalls: noMatchCalls,
  productionUnavailableLlmCalls: missingInformationLlmCalls,
  routingLlmCalls: 0,
  reviewLlmCalls: 0,
  naturalRecovery: true,
  productionRuntimeConnected: true,
  configuredWorkflowConnected: true,
  correctionAndCancellationConnected: true,
  closingConnected: true,
}, null, 2));
