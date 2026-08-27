import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import {
  createSelectedLlmStream,
  estimateLlmPromptTokens,
} from '../src/voice/providers/llm/llm-response.service.js';
import {
  configuredSafeFailureResponse,
  configuredTechnicalFailureResponse,
  configuredOperationalFailureResponse,
  llmOperationalFailureClass,
} from '../src/voice/realtime-conversation-orchestrator.js';

let providerRequest = null;
const adapter = {
  stream(request) {
    providerRequest = request;
    return (async function* emptyStream() {
      yield { type: 'completed', finishReason: 'stop' };
    }());
  },
  cancel() {},
  close() {},
};
const records = Array.from({ length: 6 }, (_, index) => ({
  sourceId: `source_${index + 1}`,
  publishedEvidenceId: `published_${index + 1}`,
  recordId: `record_${index + 1}`,
  recordType: 'KNOWLEDGE_CHUNK',
  tenantId: 'must-not-enter-compact-input',
  content: `Approved tenant fact ${index + 1}. ${'supporting detail '.repeat(30)}`,
  authoritativeData: {
    heading: `Published heading ${index + 1}`,
    content: `Approved tenant fact ${index + 1}. ${'supporting detail '.repeat(30)}`,
  },
  provenance: { documentId: `document_${index + 1}` },
}));
const recentRelevantTurns = Array.from({ length: 7 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `Relevant turn ${index + 1}`,
}));
const applicableSchema = {
  name: 'configured_action', authorizationEvidenceId: 'workflow_source_1',
  inputSchema: {
    type: 'object', properties: { requestedValue: { type: 'string' } },
    required: ['requestedValue'], additionalProperties: false,
  },
};
const profile = {
  agent: { name: 'Synthetic Agent', language: 'English', temperature: 0, settings: {} },
  providers: { llm: { providerId: 'provider', providerName: 'mock', modelId: 'model', modelKey: 'mock' } },
  tools: [{ name: 'unrelated_assigned_tool', configuration: {} }],
};
const currentQuestion = 'What does this published option include?';
const session = await createSelectedLlmStream(profile, {
  callId: 'synthetic-call', query: currentQuestion,
  history: [{ role: 'assistant', content: 'duplicate external history' }], historyLimit: 4,
  knowledge: { found: true, route: 'knowledge_engine', tenantEvidence: { sources: [] } },
  context: {
    groundedResponseMode: true,
    groundedDecisionInput: {
      currentQuestion,
      recentRelevantTurns,
      canonicalMemory: { activeEntity: { recordId: 'record_1', name: 'Published heading 1' } },
      hydratedRecords: records,
      workflowAuthorization: [{ workflowEvidenceId: 'workflow_source_1', toolName: 'configured_action' }],
      toolSchemas: [applicableSchema],
      forbiddenInternalRouting: 'must-not-enter-compact-input',
      ambiguityCandidates: [{ name: 'must-not-enter-compact-input' }],
    },
  },
  usageDirection: 'inbound',
}, { adapter, skipDefaultRegistration: true });

assert.ok(providerRequest, 'The provider should receive a request within budget');
assert.equal(session.historyMessages, 0, 'Relevant turns must not be duplicated as provider history');
assert.ok(session.promptCharacters <= env.VOICE_LLM_PROMPT_BUDGET_CHARS);
assert.ok(session.estimatedPromptTokens <= env.VOICE_LLM_PROMPT_BUDGET_TOKENS);
assert.equal(estimateLlmPromptTokens(providerRequest.messages), session.estimatedPromptTokens);
assert.equal(providerRequest.messages.length, 2);
assert.equal(providerRequest.messages[1].content, currentQuestion);

const systemPrompt = providerRequest.messages[0].content;
const match = /<grounded_turn_input>\n([\s\S]+)\n<\/grounded_turn_input>/u.exec(systemPrompt);
assert.ok(match, 'The complete grounded input must be present');
const groundedInput = JSON.parse(match[1]);
assert.deepEqual(Object.keys(groundedInput), [
  'currentQuestion', 'recentRelevantTurns', 'canonicalMemory', 'hydratedRecords',
  'workflowAuthorization', 'toolSchemas',
]);
assert.equal(groundedInput.recentRelevantTurns.length, 4);
assert.equal(groundedInput.hydratedRecords.length, 5);
assert.deepEqual(groundedInput.toolSchemas.map((tool) => tool.name), ['configured_action']);
assert.doesNotMatch(systemPrompt, /duplicate external history|unrelated_assigned_tool|must-not-enter-compact-input/u);

assert.equal(llmOperationalFailureClass({ code: 'LLM_PROVIDER_TIMEOUT' }), 'timeout');
assert.equal(llmOperationalFailureClass({ code: 'VOICE_TURN_STAGE_TIMEOUT' }), 'timeout');
assert.equal(llmOperationalFailureClass({ code: 'LLM_GROUNDED_PROMPT_BUDGET_EXCEEDED' }), 'prompt_budget');
assert.equal(llmOperationalFailureClass({ code: 'LLM_PROVIDER_UNAVAILABLE' }), 'provider_failure');
const operationalProfile = { agent: { settings: {
  knowledgeClarificationMessage: 'Please choose one published option.',
  technicalFailureMessage: 'The information service is temporarily unavailable.',
  evidenceValidationFailureMessage: 'The published answer could not be validated.',
} } };
assert.equal(configuredSafeFailureResponse(operationalProfile),
  'Please choose one published option.');
assert.equal(configuredTechnicalFailureResponse(operationalProfile),
  'The information service is temporarily unavailable.');
assert.notEqual(configuredTechnicalFailureResponse(operationalProfile),
  configuredSafeFailureResponse(operationalProfile),
  'Operational failures must never use the generic ambiguity fallback');
assert.equal(configuredOperationalFailureResponse(operationalProfile),
  'The information service is temporarily unavailable.');
assert.equal(configuredOperationalFailureResponse(
  operationalProfile, {}, { validation: true },
), 'The published answer could not be validated.');
assert.notEqual(configuredOperationalFailureResponse(
  operationalProfile, {}, { validation: true },
), configuredSafeFailureResponse(operationalProfile),
'Evidence validation failure must never use the ambiguity response');

await session.close();
console.log('Compact grounded LLM input, budgets and timeout separation verified.');
