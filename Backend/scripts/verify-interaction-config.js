import assert from 'node:assert/strict';
import {
  cachePolicies,
  greetingModes,
  normalizeContextId,
  normalizeInteractionSettings,
  resolveInteractionConfiguration,
} from '../src/voice/interaction/interaction-config.js';

assert.deepEqual(resolveInteractionConfiguration({}), {
  greetingMode: greetingModes.AGENT_INITIATES,
  cachePolicy: cachePolicies.PERSISTENT_24H,
  contextId: null,
});

assert.deepEqual(resolveInteractionConfiguration({
  greetingMode: 'Agent Initiates (Standard)',
  cachePolicy: '24h Persistent',
  contextId: 'Optional',
}), {
  greetingMode: greetingModes.AGENT_INITIATES,
  cachePolicy: cachePolicies.PERSISTENT_24H,
  contextId: null,
});

assert.deepEqual(resolveInteractionConfiguration({
  greetingMode: 'User Initiates',
  cachePolicy: 'Session Only',
  contextId: 'crm:lead/123-ABC',
}), {
  greetingMode: greetingModes.USER_INITIATES,
  cachePolicy: cachePolicies.SESSION_ONLY,
  contextId: 'crm:lead/123-ABC',
});

const original = { greetingMode: 'user_initiates', cachePolicy: 'Disabled', custom: true };
const normalized = normalizeInteractionSettings(original);
assert.deepEqual(normalized, {
  greetingMode: greetingModes.USER_INITIATES,
  cachePolicy: cachePolicies.DISABLED,
  contextId: null,
  custom: true,
});
assert.equal(original.cachePolicy, 'Disabled');

assert.equal(normalizeContextId(' phone_+919489974421 ', { strict: true }), 'phone_+919489974421');
assert.equal(normalizeContextId('Optional', { strict: true }), null);
assert.throws(
  () => normalizeContextId('customer id with spaces', { strict: true }),
  (error) => error.code === 'VOICE_CONTEXT_ID_INVALID' && error.field === 'contextId',
);
assert.throws(
  () => normalizeInteractionSettings({ greetingMode: 'random mode' }),
  (error) => error.code === 'VOICE_INTERACTION_CONFIG_INVALID' && error.field === 'greetingMode',
);

console.log(JSON.stringify({ success: true, task: 'Greeting, cache and context configuration' }));

