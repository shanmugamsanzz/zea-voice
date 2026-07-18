import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';

const { CallController } = await import('../src/voice/call-controller.js');
const { callStates } = await import('../src/voice/call-state-machine.js');
const { ActiveCallSessionStore } = await import('../src/voice/call-session-store.js');

const events = { states: [], transcripts: [], interrupts: [], cleanup: [] };
const controller = new CallController({
  callSession: { id: 'call-1', providerCallId: 'plivo-1' },
  runtimeProfile: { agent: {
    id: 'agent-1', welcomeMessage: 'Hello, how may I help?', settings: {
      silentMessage: 'Are you still there?', maxInactivityPrompts: 1,
    },
  } },
  hooks: {
    onStateChange: async (event) => events.states.push(event),
    onTranscript: async (event) => events.transcripts.push(event),
    onInterrupt: async (event) => events.interrupts.push(event),
    onCleanup: async (event) => events.cleanup.push(event),
  },
  now: 1000,
});

assert.equal((await controller.initialize(1100)).action, 'speak');
assert.equal(controller.state, callStates.GREETING);
await controller.greetingComplete(1200);
const turn = await controller.receiveFinalTranscript('I need some information.', 1300);
assert.equal(turn.action, 'generate_response');
assert.equal(controller.state, callStates.THINKING);
await controller.setAssistantResponse('I can help with that.', 1400);
assert.equal(controller.state, callStates.SPEAKING);
assert.equal((await controller.interrupt('caller_barge_in', 1500)).action, 'cancel_playback');
assert.equal(controller.state, callStates.LISTENING);
assert.equal(events.interrupts.length, 1);

const secondTurn = await controller.receiveFinalTranscript('Please continue.', 1600);
assert.equal(secondTurn.history.at(-1).content, 'Please continue.');
await controller.setAssistantResponse('Here is the information.', 1700);
await controller.playbackComplete(1800);
assert.equal((await controller.handleSilence(1900)).action, 'inactivity_response');
await controller.setAssistantResponse('Are you still there?', 2000);
await controller.playbackComplete(2100);
assert.equal((await controller.handleSilence(2200)).action, 'close');
const completed = await controller.complete('inactivity_limit_reached', 2300);
assert.equal(completed.state, callStates.COMPLETED);
assert.equal(events.cleanup.length, 1);
assert.equal(events.transcripts[0].speaker, 'agent');
assert.equal(events.transcripts[1].speaker, 'user');

await assert.rejects(
  controller.receiveFinalTranscript('Too late'),
  (error) => error.code === 'VOICE_CALL_NOT_LISTENING',
);

let clock = 1000;
const store = new ActiveCallSessionStore({ ttlSeconds: 1, now: () => clock });
store.add('call-1', controller);
assert.equal(store.get('call-1'), controller);
clock = 2500;
assert.equal(store.get('call-1'), null);
assert.equal(store.size, 0);

console.log(JSON.stringify({ success: true, task: 'Voice Task 9 - provider-independent conversation state' }));
