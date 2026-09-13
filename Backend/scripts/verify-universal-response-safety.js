import assert from 'node:assert/strict';
import { normalizedNumericTokens, shortenCompleteSpeech } from '../src/voice/interaction/universal-response-safety.js';
import { applyUniversalWorkflowResult } from '../src/voice/interaction/template-engine-universal-workflow.js';
import { classifyTemplateEngineTurnError } from '../src/voice/interaction/template-engine-error-classification.js';
import { runAgentQdrantUniversalTurn } from '../src/voice/interaction/agent-qdrant-grounded-turn.js';

for (const value of ['1,650', '1650.00', '+01650', '１６５０', '١٦٥٠', '௧௬௫௦']) {
  assert.deepEqual([...normalizedNumericTokens(value)], ['1650']);
}
assert.deepEqual([...normalizedNumericTokens('1,23,456')], ['123456']);
assert.deepEqual([...normalizedNumericTokens('-0.50 0.50')], ['-0.5', '0.5']);
assert.notDeepEqual(normalizedNumericTokens('1,65'), normalizedNumericTokens('165'));
assert.deepEqual(normalizedNumericTokens('08:00'), normalizedNumericTokens('8:00'));
const first = 'The value is 12.50.';
assert.equal(shortenCompleteSpeech(`${first} ${'Another long sentence '.repeat(20)}.`, 80), first);
assert.throws(() => shortenCompleteSpeech('Unfinished '.repeat(100), 80),
  { code: 'TEMPLATE_ENGINE_SPEECH_BUDGET_EXCEEDED' });

const definition = { workflowId: 'flow-a', toolName: 'tool-a', requiredFields: ['value'],
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } };
const state = { activeWorkflowId: 'flow-a', collectedToolFields: { value: 'original' },
  confirmationStatus: 'awaiting_confirmation', confirmationPrompt: 'Confirm the original value?' };
const context = { currentQuestion: 'Proceed.', currentSpeech: { transcriptFinal: true },
  lastAssistantResponse: { content: state.confirmationPrompt, completion: 'complete' } };
const authorization = { intent: 'execute', utteranceComplete: true, unambiguous: true, quote: 'Proceed.' };
let executed = 0;
const input = { outcome: 'WORKFLOW_ACTION', state, definitions: [definition],
  workflowAction: { action: 'EXECUTE', workflowId: 'flow-a', toolName: 'tool-a', arguments: {} },
  actionAuthorization: authorization, conversationContext: context,
  executeAuthorizedTool: async () => { executed += 1; return { success: true }; } };
for (const changed of [
  { workflowAction: { ...input.workflowAction, arguments: { value: 'changed' } } },
  { state: { ...state, collectedToolFields: { value: '' } } },
  { state: { ...state, confirmationPrompt: null } },
  { conversationContext: { ...context, lastAssistantResponse: { ...context.lastAssistantResponse, completion: 'interrupted' } } },
  { conversationContext: { ...context, lastAssistantResponse: { content: 'Unrelated response', completion: 'complete' } } },
  { conversationContext: { ...context, currentSpeech: { transcriptFinal: true, semanticCompletion: 'incomplete' } } },
  { actionAuthorization: { ...authorization, unambiguous: false } },
  { actionAuthorization: { ...authorization, quote: 'Not spoken' } },
]) {
  await assert.rejects(() => applyUniversalWorkflowResult({ ...input, ...changed }));
  assert.equal(executed, 0);
}
await applyUniversalWorkflowResult(input);
assert.equal(executed, 1);
const corrected = await applyUniversalWorkflowResult({ ...input,
  speech: 'Confirm the corrected value?', workflowAction: { ...input.workflowAction,
    action: 'UPSERT', arguments: { value: 'corrected' } } });
assert.equal(corrected.state.confirmationPrompt, 'Confirm the corrected value?');
assert.equal(corrected.state.collectedToolFields.value, 'corrected');
assert.equal(executed, 1);

const retrieval = { request: { tenantId: 'tenant-a', agentId: 'agent-a', previousContext: [] },
  chunks: [], diagnostics: {} };
let llmCalls = 0;
for (const auth of [null, { ...authorization, intent: 'close', utteranceComplete: false },
  { ...authorization, intent: 'close', unambiguous: false }]) {
  await assert.rejects(() => runAgentQdrantUniversalTurn({ retrieval,
    currentQuestion: 'Proceed.', conversationContext: context }, {
    invokeStructuredLlm: async () => {
      llmCalls += 1;
      return { outputParsed: { outcome: 'CLOSING', speech: 'Closing.', evidenceIds: [],
        workflowAction: null, grounding: null, actionAuthorization: auth } };
    },
  }), { code: 'QDRANT_UNIVERSAL_LLM_ACTION_NOT_AUTHORIZED' });
}
assert.equal(llmCalls, 3);
for (const code of ['QDRANT_UNIVERSAL_LLM_CLAIM_SUPPORT_INVALID',
  'QDRANT_UNIVERSAL_LLM_ACTION_NOT_AUTHORIZED', 'TEMPLATE_ENGINE_UNIVERSAL_WORKFLOW_NOT_READY',
  'TEMPLATE_ENGINE_LLM_INVALID_JSON', 'TEMPLATE_ENGINE_SPEECH_BUDGET_EXCEEDED']) {
  assert.equal(classifyTemplateEngineTurnError({ code }), 'validation');
}
assert.equal(classifyTemplateEngineTurnError({ code: 'LLM_PROVIDER_TIMEOUT' }), 'operational');
assert.equal(classifyTemplateEngineTurnError({ code: 'TEMPLATE_ENGINE_LLM_INCOMPLETE' }), 'operational');
assert.equal(classifyTemplateEngineTurnError({ name: 'AbortError' }), 'cancelled');
console.log('Universal response safety: passed');
