import assert from 'node:assert/strict';
import { resolveInterruptionConfiguration } from '../src/voice/interruption/interruption-config.js';
import { agentControlDefaults, resolveMaxInactivityPrompts } from '../src/voice/agent-control-defaults.js';
import { CallController } from '../src/voice/call-controller.js';

const settings = { timeBasedInterruptionEnabled: false, speechConfirmationDelayMs: 650,
  minimumMeaningfulWords: 1, maxInactivityPrompts: 3, silentMessage: 'Configured check.',
  greetingMode: 'user_initiates', explicitStopPhrases: ['Configured stop'], acknowledgementPhrases: [] };
const config = resolveInterruptionConfiguration(settings, 0.1);
assert.equal(config.timeBased.enabled, false);
assert.equal(config.timeBased.thresholdMs, 650);
assert.equal(config.wordBased.minimumWords, 1);
assert.deepEqual(config.explicitStopPhrases, ['Configured stop']);
assert.equal(resolveMaxInactivityPrompts(settings), 3);
assert.equal(resolveMaxInactivityPrompts({}), agentControlDefaults.maxInactivityPrompts);
const controller = new CallController({callSession:{id:'call-1'},runtimeProfile:{agent:{id:'agent-1',settings}}});
await controller.initialize();
for(let i=0;i<3;i++) {
  const action=await controller.handleSilence();
  assert.equal(action.action,'inactivity_response');
  assert.equal(action.text,'Configured check.');
  await controller.setAssistantResponse(action.text);
  await controller.playbackComplete();
}
assert.equal((await controller.handleSilence()).reason,'inactivity_limit_reached');
console.log('Saved UI settings override compatibility defaults; configured silence behavior preserved');
