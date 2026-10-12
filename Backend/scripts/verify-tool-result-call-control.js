import assert from 'node:assert/strict';
import { runToolResultResponse } from '../src/voice/interaction/tool-result-response.js';

const run = (decision, success = true) => runToolResultResponse({
  conversationContext: { recentConversation: [
    { role: 'user', content: 'I would like an appointment.' },
    { role: 'assistant', content: 'What is the patient name?' },
    { role: 'user', content: 'Shanmukham' },
  ] },
  workflowState: { activeWorkflowId: 'intake', collectedFields: { name: 'Shanmukham' } },
  agentPrompt: 'Follow the caller request and tool result when choosing whether to end.',
  currentQuestion: 'Please arrange the follow-up.',
  toolCall: { name: 'configured_action', arguments: {} },
  toolResult: { success, output: { scheduled: success } },
  invokeStructuredLlm: async request => {
    assert.deepEqual(request.responseFormat.schema.properties.callControl.enum, ['continue', 'close']);
    assert.ok(request.responseFormat.schema.required.includes('callControl'));
    const instructions = request.messages[0].content;
    assert.ok(instructions.includes('I would like an appointment.'));
    assert.ok(instructions.includes('What is the patient name?'));
    assert.ok(instructions.includes('Shanmukham'));
    assert.ok(instructions.includes('"activeWorkflowId":"intake"'));
    return { outputParsed: { speech: 'The action result is available.', ...decision } };
  },
});
assert.equal((await run({ callControl: 'close' })).callControl, 'close');
assert.equal((await run({ callControl: 'continue' })).callControl, 'continue');
// Business success does not force hangup; the model owns the decision.
assert.equal((await run({ callControl: 'continue' }, false)).callControl, 'continue');
assert.equal((await run({})).callControl, 'continue');
await assert.rejects(run({ callControl: 'invalid' }), { code: 'TOOL_RESULT_LLM_CALL_CONTROL_INVALID' });
console.log('Tool-result call-control checks passed');
