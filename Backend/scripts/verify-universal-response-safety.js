import assert from 'node:assert/strict';
import { shortenCompleteSpeech } from '../src/voice/interaction/universal-response-safety.js';
import { applyUniversalWorkflowResult } from '../src/voice/interaction/template-engine-universal-workflow.js';
import { classifyTemplateEngineTurnError } from '../src/voice/interaction/template-engine-error-classification.js';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';

const first = 'The value is 12.50.';
assert.equal(shortenCompleteSpeech(`${first} ${'Another long sentence '.repeat(20)}.`, 80), first);
const clippedLongSentence = shortenCompleteSpeech('Unfinished '.repeat(100), 80);
assert.ok(clippedLongSentence.startsWith('Unfinished'));
assert.ok(Array.from(clippedLongSentence).length <= 80);

const definition = { workflowId: 'flow-a', toolName: 'tool-a', requiredFields: ['value'],
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } };
const state = { activeWorkflowId: 'flow-a', collectedToolFields: { value: 'original' },
  confirmationStatus: 'awaiting_confirmation', confirmationPrompt: 'Confirm the original value?' };
const context = { currentQuestion: 'Proceed.', currentSpeech: { transcriptFinal: true },
  lastAssistantResponse: { content: state.confirmationPrompt, completion: 'complete' } };
const authorization = { intent: 'execute', utteranceComplete: true, unambiguous: true, quote: 'Proceed.' };
let executed = 0;
const input = { outcome: 'WORKFLOW_ACTION', state, definitions: [definition],
  workflowAction: { action: 'EXECUTE', workflowId: 'flow-a', toolName: 'tool-a', arguments: {},
    authorizationQuote: authorization.quote },
  conversationContext: context,
  executeAuthorizedTool: async () => { executed += 1; return { success: true }; } };
for (const changed of [
  { workflowAction: { ...input.workflowAction, arguments: { unexpected: 'value' } } },
  { state: { ...state, collectedToolFields: { value: '' } } },
  { conversationContext: { ...context, currentSpeech: { transcriptFinal: true, semanticCompletion: 'incomplete' } } },
  { workflowAction: { ...input.workflowAction, authorizationQuote: 'Not spoken' } },
  { workflowAction: { ...input.workflowAction, authorizationQuote: '' } },
]) {
  await assert.rejects(() => applyUniversalWorkflowResult({ ...input, ...changed }));
  assert.equal(executed, 0);
}
await applyUniversalWorkflowResult(input);
assert.equal(executed, 1);
// A configured tool may execute without an old backend confirmation state,
// but only with valid fields and an explicit final caller utterance.
await applyUniversalWorkflowResult({ ...input,
  state: {},
  workflowAction: { ...input.workflowAction, arguments: { value: 'current' } },
});
assert.equal(executed, 2);
const corrected = await applyUniversalWorkflowResult({ ...input,
  speech: 'Confirm the corrected value?', workflowAction: { ...input.workflowAction,
    action: 'UPSERT', arguments: { value: 'corrected' } } });
assert.equal(corrected.state.confirmationPrompt, 'Confirm the corrected value?');
assert.equal(corrected.state.collectedToolFields.value, 'corrected');
assert.equal(executed, 2);

const retrieval = { request: { tenantId: 'tenant-a', agentId: 'agent-a', previousContext: [] },
  chunks: [], diagnostics: {} };
let llmCalls = 0;
const closing = await runAgentQdrantUniversalTurn({ retrieval,
  currentQuestion: 'Proceed.', conversationContext: context }, {
  invokeStructuredLlm: async () => {
    llmCalls += 1;
    return { outputParsed: { outcome: 'CLOSING', speech: 'Closing.', workflowAction: null } };
  },
});
assert.equal(closing.outcome, 'CLOSING');
assert.equal(llmCalls, 1);
for (const code of ['QDRANT_UNIVERSAL_LLM_ACTION_NOT_AUTHORIZED',
  'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_READY']) {
  assert.equal(classifyTemplateEngineTurnError({ code }), 'action');
}
assert.equal(classifyTemplateEngineTurnError({ code: 'TEMPLATE_ENGINE_LLM_INVALID_JSON' }),
  'operational');
assert.equal(classifyTemplateEngineTurnError({ code: 'LLM_PROVIDER_TIMEOUT' }), 'operational');
assert.equal(classifyTemplateEngineTurnError({ code: 'TEMPLATE_ENGINE_LLM_INCOMPLETE' }), 'operational');
assert.equal(classifyTemplateEngineTurnError({ name: 'AbortError' }), 'cancelled');
console.log('Universal response safety: passed');
