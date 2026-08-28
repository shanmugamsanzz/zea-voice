import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CallController } from '../src/voice/call-controller.js';

const frontend = readFileSync(new URL(
  '../../Frontend/src/components/agent/AgentTabs.tsx', import.meta.url,
), 'utf8');
const frontendTypes = readFileSync(new URL('../../Frontend/src/types.ts', import.meta.url), 'utf8');

assert.match(frontend, /Maximum Prompts/u);
assert.match(frontend, /maxInactivityPrompts:\s*Number\(savedSettings\.maxInactivityPrompts/u);
assert.match(frontend, /maxInactivityPrompts,\s*\n\s*conversationMemoryFields/u);
assert.match(frontend, /Maximum Inactivity Prompts must be between 1 and 10/u);
assert.match(frontendTypes, /maxInactivityPrompts\?: number/u);

const controller = new CallController({
  callSession: { id: 'call-ui-inactivity', providerCallId: 'provider-ui-inactivity' },
  runtimeProfile: { agent: {
    id: 'agent-ui-inactivity',
    settings: {
      greetingMode: 'user_initiates',
      silentMessage: 'Configured caller check.',
      maxInactivityPrompts: 3,
    },
  } },
});

assert.equal((await controller.initialize()).action, 'listen');
for (let prompt = 1; prompt <= 3; prompt += 1) {
  const action = await controller.handleSilence();
  assert.equal(action.action, 'inactivity_response');
  assert.equal(action.text, 'Configured caller check.');
  assert.equal(action.silenceCount, prompt);
  await controller.setAssistantResponse(action.text);
  await controller.playbackComplete();
}
const close = await controller.handleSilence();
assert.equal(close.action, 'close');
assert.equal(close.reason, 'inactivity_limit_reached');

console.log(JSON.stringify({
  passed: true,
  configuredPrompts: 3,
  closesOnSilenceEvent: 4,
  callerFacingTextFromUi: true,
}));
