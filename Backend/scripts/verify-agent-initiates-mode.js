import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { CallController } = await import('../src/voice/call-controller.js');
const { callStates } = await import('../src/voice/call-state-machine.js');

function controllerFor(agent, events = []) {
  return new CallController({
    callSession: { id: `call-${events.length}`, providerCallId: 'plivo-test' },
    runtimeProfile: { agent: { id: 'agent-1', settings: {}, ...agent } },
    hooks: {
      onTranscript: async (event) => events.push(event),
      onStateChange: async () => {},
    },
  });
}

const transcripts = [];
const canonical = controllerFor({
  welcomeMessage: 'Welcome to Shanmuga Hospital.',
  speech: { interaction: { greetingMode: 'agent_initiates', cachePolicy: 'persistent_24h' } },
}, transcripts);
const canonicalAction = await canonical.initialize();
assert.equal(canonicalAction.action, 'speak');
assert.equal(canonicalAction.greetingMode, 'agent_initiates');
assert.equal(canonical.state, callStates.GREETING);
assert.equal(transcripts[0].speaker, 'agent');
assert.equal(transcripts[0].text, 'Welcome to Shanmuga Hospital.');
await canonical.greetingComplete();
assert.equal(canonical.state, callStates.LISTENING);

const interruptedGreeting = controllerFor({
  welcomeMessage: 'A longer welcome that the caller may interrupt.',
  speech: { interaction: { greetingMode: 'agent_initiates' } },
});
await interruptedGreeting.initialize();
assert.equal((await interruptedGreeting.interrupt('caller_barge_in')).action, 'cancel_playback');
assert.equal(interruptedGreeting.state, callStates.LISTENING);

const legacy = controllerFor({
  welcomeMessage: 'Legacy welcome.',
  settings: { greetingMode: 'Agent Initiates (Standard)', cachePolicy: '24h Persistent' },
});
assert.equal((await legacy.initialize()).action, 'speak');
assert.equal(legacy.state, callStates.GREETING);

const missingWelcome = controllerFor({
  welcomeMessage: '',
  speech: { interaction: { greetingMode: 'agent_initiates' } },
});
const missingAction = await missingWelcome.initialize();
assert.equal(missingAction.action, 'listen');
assert.equal(missingAction.reason, 'agent_initiates_without_welcome');
assert.equal(missingWelcome.state, callStates.LISTENING);

const userInitiates = controllerFor({
  welcomeMessage: 'This must not be spoken.',
  speech: { interaction: { greetingMode: 'user_initiates' } },
});
const userAction = await userInitiates.initialize();
assert.equal(userAction.action, 'listen');
assert.equal(userAction.reason, 'user_initiates');
assert.equal(userInitiates.history.length, 0);

console.log(JSON.stringify({ success: true, task: 'Agent-Initiates greeting mode' }));
