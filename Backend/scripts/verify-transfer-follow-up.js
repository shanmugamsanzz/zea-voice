import assert from 'node:assert/strict';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
const { TransferFollowUp, verifiedTransferResult } = await import('../src/voice/transfer-follow-up.js');
const { isCallTransferEnabledForAgent } = await import('../src/voice/call-transfer-feature.js');
const { runToolResultResponse } = await import('../src/voice/interaction/tool-result-response.js');
const { executeAgentTool } = await import('../src/voice/tools/tool-executor.service.js');
const { applyUniversalWorkflowResult, buildUniversalWorkflowDefinitions } = await import('../src/voice/interaction/template-engine-universal-workflow.js');
const tool = { id: 'callback-a', name: 'request_staff_callback', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const attempt = { id: 'transfer-a', mode: 'wait_and_return', callback_tool_id: tool.id };
const result = output => ({ toolId: tool.id, verified: true, success: output?.success === true, output });
assert.equal(isCallTransferEnabledForAgent('agent-a', { CALL_TRANSFER_ENABLED: false, CALL_TRANSFER_AGENT_IDS: 'agent-a' }), false);
assert.equal(isCallTransferEnabledForAgent('agent-a', { CALL_TRANSFER_ENABLED: true, CALL_TRANSFER_AGENT_IDS: '' }), false);
assert.equal(isCallTransferEnabledForAgent('agent-b', { CALL_TRANSFER_ENABLED: true, CALL_TRANSFER_AGENT_IDS: 'agent-a' }), false);
assert.equal(isCallTransferEnabledForAgent('agent-a', { CALL_TRANSFER_ENABLED: true, CALL_TRANSFER_AGENT_IDS: ' agent-a ' }), true);
const state = new TransferFollowUp();
assert.equal(state.promptContext(), ''); state.setOutcome({ status: 'busy' }); assert.equal(state.outcome, null);
state.setOutcome(verifiedTransferResult(attempt, 'no-answer'));
assert.match(state.promptContext([tool]), /request_staff_callback/);
assert.match(state.promptContext([tool]), /"saved":false/);
assert.match(state.promptContext([]), /No staff callback action/);
assert.equal(state.executions.size, 0, 'Exposing the result must not automatically execute a callback');

for (const output of [null, { success: true }, { success: true, saved: true },
  { success: false, saved: true, requestId: 'not-saved' }, { success: true, saved: false, requestId: 'not-saved' },
  { success: true, saved: true, requestId: '  ' }]) {
  const unconfirmed = await state.execute(tool.id, async () => result(output));
  assert.equal(unconfirmed.success, false); assert.equal(unconfirmed.transferFollowUp.accepted, false);
  assert.equal(state.outcome.callback.saved, false);
}
await assert.rejects(state.execute(tool.id, async () => { throw Error('Network failure'); }));
assert.equal(state.outcome.callback.status, 'failed');
const workflow = await applyUniversalWorkflowResult({ outcome: 'WORKFLOW_ACTION',
  workflowAction: { workflowId: tool.id, toolName: tool.name, action: 'EXECUTE', arguments: {}, authorizationQuote: 'Please arrange a staff callback.' },
  definitions: buildUniversalWorkflowDefinitions({ authorizedTools: [tool] }),
  conversationContext: { currentQuestion: 'Please arrange a staff callback.', currentSpeech: { transcriptFinal: true, semanticCompletion: 'complete' } },
  executeAuthorizedTool: async () => state.execute(tool.id, async () => result({ success: false })),
});
assert.equal(workflow.toolExecuted, true); assert.equal(workflow.toolResult.success, false,
  'A verified failed callback reaches the result-response path rather than a generic error');
let llmRequest;
await runToolResultResponse({ agentPrompt: 'Help the caller.', currentQuestion: 'Please arrange a staff callback.',
  maximumSpeechCharacters: 1000,
  toolResult: workflow.toolResult, invokeStructuredLlm: async request => {
    llmRequest = request; return { outputParsed: { speech: 'I could not confirm the callback request. May I help with anything else?', callControl: 'continue' } };
  } });
assert.match(llmRequest.messages[0].content, /"accepted":false/);
assert.match(llmRequest.messages[0].content, /overrides any raw provider success field/);

let calls = 0; let release;
const gate = new Promise(resolve => { release = resolve; });
const save = async () => { calls++; await gate; return result({ success: true, saved: true, requestId: 'actual-request-123', notified: false }); };
const one = state.execute(tool.id, save); const duplicate = state.execute(tool.id, save);
assert.equal(state.outcome.callback.status, 'pending'); release();
const accepted = await one;
assert.deepEqual(await duplicate, accepted); assert.equal(calls, 1);
assert.equal(state.outcome.callback.saved, true); assert.equal(state.outcome.callback.staffNotified, false);
await state.execute(tool.id, save); assert.equal(calls, 1, 'A saved callback must not be submitted again for this transfer');
assert.match(state.promptContext([tool]), /actual-request-123/);
assert.match(state.promptContext([tool]), /"status":"saved"/);
state.setOutcome(verifiedTransferResult(attempt, 'no-answer'));
assert.equal(state.outcome.callback.saved, true, 'Duplicate transfer results do not erase callback success');
let unrelated = 0;
await state.execute('another-tool', async () => { unrelated++; return { success: true }; }); assert.equal(unrelated, 1);
const otherCompanyCall = new TransferFollowUp(); otherCompanyCall.setOutcome(verifiedTransferResult(attempt, 'busy'));
assert.equal(otherCompanyCall.outcome.callback.saved, false, 'A separate company/call cannot inherit callback success');
const outbound = { id: 'call-a', direction: 'outbound', from: '+918000000001', to: '+919000000002' };
const profile = { agent: { id: 'agent-a', tenantId: 'company-a', workspaceId: 'workspace-a' },
  tools: [{ ...tool, type: 'webhook_api', configuration: { url: 'https://example.com/callback', inputSchema: tool.inputSchema } }] };
let payload;
const dependencies = { requireWorkflowAuthorization: true, workflowAuthorization: { recordId: tool.id, toolName: tool.name },
  verifiedTransferCallback: { callId: outbound.id, toolId: tool.id }, resolveDns: false,
  fetchImpl: async (_, options) => { payload = JSON.parse(options.body); return { ok: true, status: 200,
    text: async () => JSON.stringify({ success: true, saved: true, requestId: 'saved-callback' }) }; } };
await executeAgentTool(profile, outbound, { name: tool.name, authorizationRecordId: tool.id, arguments: {} }, dependencies);
assert.equal(payload.callerPhoneNumber, outbound.to); assert.equal(payload.mobileNumber, outbound.to);
assert.equal(payload.callContext.fromNumber, outbound.from, 'Call direction metadata remains unchanged');
await assert.rejects(executeAgentTool(profile, { ...outbound, to: null },
  { name: tool.name, authorizationRecordId: tool.id, arguments: {} }, dependencies), error => error.code === 'TRANSFER_CALLBACK_PHONE_MISSING');
console.log('Transfer follow-up passed: persistent verified context, callback contract, failed-action response, pending/saved/notification distinctions, duplicate action suppression, retry after failure, call isolation and one-agent/default-off rollout. No live calls were made.');
