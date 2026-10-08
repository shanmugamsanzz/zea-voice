import assert from 'node:assert/strict';
import { runToolResultResponse } from '../src/voice/interaction/tool-result-response.js';

const run = (decision, success = true) => runToolResultResponse({
  agentPrompt: 'Follow the caller request and tool result when choosing whether to end.',
  currentQuestion: 'Please arrange the follow-up.',
  toolCall: { name: 'configured_action', arguments: {} },
  toolResult: { success, output: { scheduled: success } },
  invokeStructuredLlm: async request => {
    assert.deepEqual(request.responseFormat.schema.properties.callControl.enum, ['continue', 'close']);
    assert.ok(request.responseFormat.schema.required.includes('callControl'));
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
