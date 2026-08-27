import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openGenericConversationState } from '../src/voice/interaction/generic-conversation-state.js';
import { resolveNextConfiguredQuestion } from '../src/voice/interaction/next-question-policy.js';

const memory = openGenericConversationState({
  tenantId: 'tenant-1', workspaceId: 'workspace-1', agentId: 'agent-1', callId: 'call-1',
}, {}, Date.now(), {
  currentTopic: 'current service',
  pendingQuestion: { key: 'preferred_date', text: 'Which date works for you?', kind: 'field' },
});
memory.beginTurn('turn-1');
memory.append({ role: 'user', content: 'Hello' }, { turnToken: 'turn-1' });
memory.cancelTurn('turn-1');
assert.equal(memory.snapshot().pendingQuestion.text, 'Which date works for you?');

const resumed = resolveNextConfiguredQuestion({
  decision: { decision: 'answer', pendingQuestionRelevant: true },
  beforeState: memory.snapshot(), afterState: memory.snapshot(),
});
assert.equal(resumed, null,
  'a saved field question must not resume without a current authorized tool or contextual continuation');
const contextualResume = resolveNextConfiguredQuestion({
  decision: {
    decision: 'answer', pendingQuestionRelevant: true,
    stateUpdate: { contextDependent: true },
  },
  beforeState: memory.snapshot(), afterState: memory.snapshot(),
});
assert.equal(contextualResume.question, 'Which date works for you?');
const discarded = resolveNextConfiguredQuestion({
  decision: { decision: 'answer', pendingQuestionRelevant: false },
  beforeState: memory.snapshot(), afterState: memory.snapshot(),
});
assert.equal(discarded, null);
memory.close();

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
for (const required of [
  /activeRetrievalAbortController\?\.abort\(reason\)/u,
  /candidate\.cancel\(reason\)/u,
  /audioEngine\?\.cancelStaleAudio\?\.\(reason\)/u,
  /cancelScheduler\(reason\)/u,
  /finalizeConfiguredToolResults/u,
  /toolDecision\.type === knowledgeEngineDecisionTypes\.RESPONSE/u,
  /Verified tool response validation fallback/u,
]) assert.match(orchestrator, required);

const frontend = readFileSync(
  new URL('../../Frontend/src/components/agent/AgentTabs.tsx', import.meta.url), 'utf8',
);
assert.match(frontend, /No active action tool is available at runtime/u);
assert.match(frontend, /exactly match the published Workflow authorization/u);
assert.match(frontend, /status:\s*'active'/u);

console.log('Interruption, continuation and configured-tool verification passed.');
