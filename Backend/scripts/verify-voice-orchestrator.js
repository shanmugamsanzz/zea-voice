import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RealtimeConversationOrchestrator } from '../src/voice/realtime-conversation-orchestrator.js';

const waitFor = async (predicate, message, timeoutMs = 2000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

class FakeMediaSession extends EventEmitter {
  constructor() {
    super();
    this.callId = 'call-1';
    this.started = true;
    this.closed = false;
    this.call = {
      id: 'call-1', providerCallId: 'plivo-1', agentId: 'agent-1', tenantId: 'tenant-1',
      workspaceId: 'workspace-1', direction: 'inbound', from: '+919000000001', to: '+918000000001',
    };
    this.log = { info() {}, warn() {}, error() {}, debug() {} };
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed', { session: this, code, reason });
  }
}

class FakeStt {
  listeners = new Set();
  sent = [];
  async connect() { this.connected = true; }
  sendAudio(value) { this.sent.push(value); }
  flush() { this.flushed = true; }
  cancel() {}
  close() { this.closed = true; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async *events() {}
  publish(event) { for (const listener of this.listeners) listener(event); }
}

class FakeLlm {
  requests = [];
  cancelled = 0;
  releaseSlow = null;
  async *stream(input) {
    this.requests.push(input);
    const query = input.messages.at(-1)?.content ?? '';
    yield { type: 'response_started' };
    if (query === 'slow request') {
      await new Promise((resolve) => { this.releaseSlow = resolve; });
      if (this.wasCancelled) { yield { type: 'cancelled', reason: 'barge-in' }; return; }
    }
    if (query === 'book appointment' && this.requests.length === 1) {
      const toolCalls = [{ id: 'tool-1', name: 'book_visit', arguments: { date: 'tomorrow' } }];
      yield { type: 'tool_call', ...toolCalls[0] };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      yield { type: 'completed', finishReason: 'tool_calls', toolCalls, usage: {} };
      return;
    }
    const text = query.includes('End the call now')
      ? 'Thank you. Goodbye.'
      : (query.includes('Open this follow-up call')
        ? 'You asked me to call back. Is now a good time to continue?'
        : 'Your appointment is booked.');
    yield { type: 'text_delta', delta: text };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } };
    yield { type: 'completed', finishReason: 'stop', toolCalls: [], usage: {} };
  }
  cancel() {
    this.cancelled += 1;
    this.wasCancelled = true;
    this.releaseSlow?.();
    return true;
  }
  close() { this.closed = true; }
}

class FakeTts {
  texts = [];
  cancelled = 0;
  async connect() {}
  async *synthesizeStream({ text, generationId }) {
    this.texts.push(text);
    yield { type: 'audio_chunk', generationId, audio: Buffer.alloc(160, this.texts.length) };
    yield { type: 'usage', generationId, usage: { characters: text.length, audioOutputMs: 20, audioBytes: 160 } };
    yield { type: 'completed', generationId, usage: { characters: text.length, audioOutputMs: 20, audioBytes: 160 } };
  }
  cancel() { this.cancelled += 1; return true; }
  close() { this.closed = true; }
}

class FakeAudioEngine {
  constructor() { this.generations = []; this.audio = []; this.cancelled = []; this.waiters = []; }
  start() { this.started = true; }
  async enqueueInbound(audio) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ data: audio });
  }
  readInbound() { return new Promise((resolve) => this.waiters.push(resolve)); }
  beginOutputGeneration(id) { this.generations.push(id); this.current = id; return id; }
  async enqueueSynthesized(audio, id) { this.audio.push({ audio, id }); return this.current === id; }
  async flushSynthesized() { return true; }
  async drainOutput() {}
  cancelStaleAudio(reason) { this.current = null; this.cancelled.push(reason); return { removedFrames: 0 }; }
  async close() { for (const resolve of this.waiters.splice(0)) resolve(null); this.closed = true; }
}

const profile = {
  agent: {
    id: 'agent-1', tenantId: 'tenant-1', workspaceId: 'workspace-1', name: 'Hospital Agent',
    description: 'Hospital receptionist', goal: 'Help callers', language: 'English (US)',
    prompt: 'Answer briefly.', welcomeMessage: 'Welcome to the hospital.', temperature: 0.2,
    inactivityTimeoutSeconds: 30, settings: { silentMessage: 'Are you still there?', maxInactivityPrompts: 1 },
  },
  providers: {
    stt: { providerId: 'stt-1', providerName: 'Sarvam', modelId: 'stt-m', modelKey: 'saaras' },
    llm: { providerId: 'llm-1', providerName: 'Azure', modelId: 'llm-m', modelKey: 'gpt-test' },
    tts: { providerId: 'tts-1', providerName: 'Cartesia', modelId: 'tts-m', modelKey: 'sonic-test' },
  },
  tools: [{ id: 'assigned-tool', name: 'book visit', type: 'webhook_api', description: 'Book a visit', configuration: {} }],
  integrations: { postCall: { prompt: 'Be polite.', messageType: 'Dynamic', dynamicClosing: true } },
};

const media = new FakeMediaSession();
const stt = new FakeStt();
const llm = new FakeLlm();
const tts = new FakeTts();
const audioEngine = new FakeAudioEngine();
const transcript = [];
const completed = [];
const knowledgeQueries = [];
const knowledgeAuth = [];
const toolInvocations = [];
const contextCacheWrites = [];
const durableMemoryWrites = [];
const previousMemory = {
  summary: 'The caller previously asked about an appointment.',
  recentMessages: [
    { role: 'user', content: 'Please call me again.' },
    { role: 'assistant', content: 'Certainly.' },
  ],
  collectedData: { customer_name: 'Test Caller' },
};
const orchestrator = new RealtimeConversationOrchestrator(media, {
  loadProfile: async () => profile,
  createAdapters: async () => ({ stt, llm, tts }),
  createAudioEngine: () => audioEngine,
  welcomeCache: { async get() { return Buffer.alloc(160, 9); }, async set() { return true; } },
  appendTranscript: async (entry) => transcript.push(entry),
  routeKnowledge: async (auth, input) => {
    knowledgeAuth.push(auth);
    knowledgeQueries.push(input.query);
    return { route: 'semantic', found: true, content: 'Appointments are available.', matches: [], durationMs: 4 };
  },
  executeTools: async (_runtimeProfile, _call, calls) => {
    toolInvocations.push(...calls);
    return calls.map((call) => ({ id: call.id, name: call.name, success: true, output: { bookingId: 'B-1' } }));
  },
  contextStore: {
    get: async () => null,
    set: async (descriptor, state) => { contextCacheWrites.push({ descriptor, state }); return true; },
    delete: async () => true,
  },
  memoryStore: {
    load: async () => ({ state: previousMemory, revision: 2 }),
    save: async (_scope, input) => {
      durableMemoryWrites.push(input);
      return { state: input.state, revision: 3 };
    },
  },
  completeCall: async (input) => { completed.push(input); return { call: { id: 'call-1' } }; },
});

await orchestrator.ready;
media.emit('start', { session: media });
await waitFor(() => audioEngine.audio.some((entry) => entry.id.startsWith('welcome-')), 'Cached welcome audio was not played');
await waitFor(() => orchestrator.controller.state === 'listening', 'Call did not enter listening state');
assert.equal(audioEngine.started, true);
assert.equal(contextCacheWrites.length, 1);

media.emit('media', { session: media, audio: Buffer.alloc(160, 2) });
await waitFor(() => stt.sent.length === 1, 'Plivo audio was not forwarded to STT');

stt.publish({ type: 'speech_started' });
stt.publish({ type: 'final_transcript', text: 'book appointment', language: 'en', isFinal: true });
await waitFor(() => transcript.some((entry) => entry.text === 'Your appointment is booked.'), 'Agent response was not persisted');
await waitFor(() => orchestrator.controller.state === 'listening', 'Call did not return to listening after playback');
assert.deepEqual(knowledgeQueries, ['book appointment']);
assert.ok(llm.requests[0].messages.some((message) => message.content === 'Please call me again.'));
assert.equal(knowledgeAuth[0].tenantId, 'tenant-1');
assert.equal(knowledgeAuth[0].workspaceId, 'workspace-1');
assert.equal(toolInvocations[0].name, 'book_visit');
assert.ok(tts.texts.includes('Your appointment is booked.'));
assert.deepEqual(transcript.map((entry) => entry.speaker), ['agent', 'user', 'agent']);

llm.wasCancelled = false;
stt.publish({ type: 'final_transcript', text: 'slow request', language: 'en', isFinal: true });
await waitFor(() => orchestrator.controller.state === 'thinking', 'Slow turn did not start');
stt.publish({ type: 'speech_started' });
await waitFor(() => orchestrator.controller.state === 'listening', 'Barge-in did not restore listening');
assert.ok(llm.cancelled > 0);
assert.ok(tts.cancelled > 0);
assert.ok(audioEngine.cancelled.includes('caller_barge_in'));

llm.wasCancelled = false;
stt.publish({ type: 'final_transcript', text: 'goodbye', language: 'en', isFinal: true });
await waitFor(() => completed.length === 1, 'Call was not finalized after closing request');
assert.equal(completed[0].outcome, 'completed');
assert.equal(completed[0].reason, 'caller_requested_hangup');
assert.equal(completed[0].metrics.latency.welcomeCacheHit, true);
assert.ok(completed[0].metrics.latency.welcomeAudioStartMs < 300);
assert.ok(completed[0].metrics.latency.firstResponseAudioMs[0] < 1000);
assert.equal(completed[0].metrics.knowledge[0].durationMs, 4);
assert.equal(completed[0].metrics.tools[0].name, 'book_visit');
assert.equal(completed[0].metrics.contextCache.hit, true);
assert.equal(completed[0].metrics.contextCache.source, 'postgresql');
assert.equal(completed[0].metrics.contextCache.persisted, true);
assert.equal(durableMemoryWrites.length, 1);
assert.equal(contextCacheWrites.length, 2);
assert.ok(durableMemoryWrites[0].state.recentMessages.some((message) => message.content === 'book appointment'));
assert.ok(tts.texts.includes('Thank you. Goodbye.'));
assert.equal(media.closed, true);

const inactivityMedia = new FakeMediaSession();
inactivityMedia.call.id = 'call-inactivity';
inactivityMedia.callId = 'call-inactivity';
const inactivityStt = new FakeStt();
const inactivityTts = new FakeTts();
const inactivityAudio = new FakeAudioEngine();
const inactivityCompleted = [];
const inactivityProfile = {
  ...profile,
  agent: {
    ...profile.agent,
    welcomeMessage: null,
    inactivityTimeoutSeconds: 0.02,
    settings: { ...profile.agent.settings, maxInactivityPrompts: 1 },
  },
  integrations: { postCall: { prompt: '', messageType: 'Static', dynamicClosing: '' } },
};
const inactivityOrchestrator = new RealtimeConversationOrchestrator(inactivityMedia, {
  loadProfile: async () => inactivityProfile,
  createAdapters: async () => ({ stt: inactivityStt, llm: new FakeLlm(), tts: inactivityTts }),
  createAudioEngine: () => inactivityAudio,
  appendTranscript: async () => {},
  contextStore: { get: async () => null, set: async () => true, delete: async () => true },
  memoryStore: { load: async () => null, save: async (_scope, input) => ({ state: input.state, revision: 1 }) },
  completeCall: async (input) => { inactivityCompleted.push(input); },
});
await inactivityOrchestrator.ready;
inactivityMedia.emit('start', { session: inactivityMedia });
await waitFor(() => inactivityTts.texts.includes('Are you still there?'), 'Inactivity prompt was not played');
await waitFor(() => inactivityCompleted.length === 1, 'Inactive call was not closed');
assert.equal(inactivityCompleted[0].reason, 'inactivity_limit_reached');
assert.ok(inactivityTts.texts.includes('Thank you for calling. Goodbye.'));

const userMedia = new FakeMediaSession();
userMedia.call.id = 'call-user-initiates';
userMedia.callId = 'call-user-initiates';
const userStt = new FakeStt();
const userTts = new FakeTts();
const userAudio = new FakeAudioEngine();
const userTranscript = [];
const deletedSessionContextKeys = [];
const userProfile = {
  ...profile,
  agent: {
    ...profile.agent,
    welcomeMessage: 'This configured welcome must not be spoken.',
    speech: { interaction: { greetingMode: 'user_initiates', cachePolicy: 'session_only', contextId: null } },
  },
};
const userOrchestrator = new RealtimeConversationOrchestrator(userMedia, {
  loadProfile: async () => userProfile,
  createAdapters: async () => ({ stt: userStt, llm: new FakeLlm(), tts: userTts }),
  createAudioEngine: () => userAudio,
  appendTranscript: async (entry) => userTranscript.push(entry),
  routeKnowledge: async () => ({ route: 'none', found: false, content: null, matches: [], durationMs: 1 }),
  contextStore: {
    get: async () => null,
    set: async () => true,
    delete: async (key) => { deletedSessionContextKeys.push(key); return true; },
  },
  completeCall: async () => {},
});
await userOrchestrator.ready;
userMedia.emit('start', { session: userMedia });
await waitFor(() => userOrchestrator.controller.state === 'listening', 'User-Initiates did not start in listening mode');
assert.equal(userTts.texts.includes('This configured welcome must not be spoken.'), false);
assert.equal(userTranscript.length, 0);
userStt.publish({ type: 'final_transcript', text: 'I need package information', language: 'en', isFinal: true });
await waitFor(() => userTranscript.some((entry) => entry.speaker === 'agent'), 'User-Initiates first turn was not answered');
assert.equal(userTranscript[0].speaker, 'user');
assert.equal(userTranscript[0].text, 'I need package information');
assert.equal(userTts.texts.at(-1), 'Your appointment is booked.');
userMedia.emit('stop', { session: userMedia });
await waitFor(() => deletedSessionContextKeys.length === 1, 'Session-only context was not deleted at call end');
assert.match(deletedSessionContextKeys[0], /:session:/);

const callbackMedia = new FakeMediaSession();
callbackMedia.call.id = 'call-callback';
callbackMedia.callId = 'call-callback';
callbackMedia.call.direction = 'outbound';
const callbackStt = new FakeStt();
const callbackTts = new FakeTts();
const callbackAudio = new FakeAudioEngine();
const callbackSchedules = [];
const callbackMemory = [];
const callbackCompleted = [];
const callbackProfile = {
  ...profile,
  agent: {
    ...profile.agent,
    speech: { interaction: { greetingMode: 'user_initiates', cachePolicy: 'persistent_24h', contextId: null } },
  },
};
const callbackOrchestrator = new RealtimeConversationOrchestrator(callbackMedia, {
  loadProfile: async () => callbackProfile,
  createAdapters: async () => ({ stt: callbackStt, llm: new FakeLlm(), tts: callbackTts }),
  createAudioEngine: () => callbackAudio,
  appendTranscript: async () => {},
  contextStore: { get: async () => null, set: async () => true, delete: async () => true },
  memoryStore: {
    load: async () => ({ state: previousMemory, revision: 1 }),
    save: async (_scope, input) => { callbackMemory.push(input); return { state: input.state, revision: 2 }; },
  },
  scheduleCallback: async (input) => {
    callbackSchedules.push(input);
    return { scheduled: true, retryCount: 1, requestedFor: input.requestedFor };
  },
  completeCall: async (input) => { callbackCompleted.push(input); },
});
await callbackOrchestrator.ready;
callbackMedia.emit('start', { session: callbackMedia });
await waitFor(() => callbackOrchestrator.controller.state === 'listening', 'Callback test call did not listen');
callbackStt.publish({ type: 'final_transcript', text: 'Please call me after 5 minutes', language: 'en', isFinal: true });
await waitFor(() => callbackCompleted.length === 1, 'Scheduled callback did not close the current call');
assert.equal(callbackSchedules.length, 1);
assert.equal(callbackCompleted[0].reason, 'customer_callback_scheduled');
assert.equal(callbackCompleted[0].metrics.callback.scheduled, true);
assert.equal(callbackMemory[0].state.callback.scheduling, 'scheduled');
assert.match(callbackMemory[0].state.summary, /Caller: Please call me after 5 minutes/);

const followUpMedia = new FakeMediaSession();
followUpMedia.call.id = 'call-follow-up';
followUpMedia.callId = 'call-follow-up';
followUpMedia.call.direction = 'outbound';
const followUpStt = new FakeStt();
const followUpTts = new FakeTts();
const followUpAudio = new FakeAudioEngine();
let followUpWelcomeCacheRead = false;
const followUpMemory = [];
const followUpCompleted = [];
const followUpOrchestrator = new RealtimeConversationOrchestrator(followUpMedia, {
  loadProfile: async () => profile,
  createAdapters: async () => ({ stt: followUpStt, llm: new FakeLlm(), tts: followUpTts }),
  createAudioEngine: () => followUpAudio,
  welcomeCache: { async get() { followUpWelcomeCacheRead = true; return Buffer.alloc(160); } },
  appendTranscript: async () => {},
  contextStore: { get: async () => null, set: async () => true, delete: async () => true },
  memoryStore: {
    load: async () => ({ state: callbackMemory[0].state, revision: 2 }),
    save: async (_scope, input) => { followUpMemory.push(input); return { state: input.state, revision: 3 }; },
  },
  completeCall: async (input) => { followUpCompleted.push(input); },
});
await followUpOrchestrator.ready;
followUpMedia.emit('start', { session: followUpMedia });
await waitFor(() => followUpTts.texts.length > 0, 'Memory-aware follow-up opening was not spoken');
assert.equal(followUpTts.texts[0], 'You asked me to call back. Is now a good time to continue?');
assert.equal(followUpWelcomeCacheRead, false);
followUpMedia.emit('stop', { session: followUpMedia });
await waitFor(() => followUpCompleted.length === 1, 'Follow-up call was not finalized');
assert.equal(followUpMemory[0].state.callback.scheduling, 'fulfilled');
assert.equal(followUpMemory[0].state.callback.scheduled, false);

console.log(JSON.stringify({ success: true, task: 'Real-time conversation orchestrator' }));
