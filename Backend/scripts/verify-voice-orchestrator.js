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
    const text = query.includes('End the call now') ? 'Thank you. Goodbye.' : 'Your appointment is booked.';
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
  completeCall: async (input) => { completed.push(input); return { call: { id: 'call-1' } }; },
});

await orchestrator.ready;
media.emit('start', { session: media });
await waitFor(() => audioEngine.audio.some((entry) => entry.id.startsWith('welcome-')), 'Cached welcome audio was not played');
await waitFor(() => orchestrator.controller.state === 'listening', 'Call did not enter listening state');
assert.equal(audioEngine.started, true);

media.emit('media', { session: media, audio: Buffer.alloc(160, 2) });
await waitFor(() => stt.sent.length === 1, 'Plivo audio was not forwarded to STT');

stt.publish({ type: 'speech_started' });
stt.publish({ type: 'final_transcript', text: 'book appointment', language: 'en', isFinal: true });
await waitFor(() => transcript.some((entry) => entry.text === 'Your appointment is booked.'), 'Agent response was not persisted');
await waitFor(() => orchestrator.controller.state === 'listening', 'Call did not return to listening after playback');
assert.deepEqual(knowledgeQueries, ['book appointment']);
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
  completeCall: async (input) => { inactivityCompleted.push(input); },
});
await inactivityOrchestrator.ready;
inactivityMedia.emit('start', { session: inactivityMedia });
await waitFor(() => inactivityTts.texts.includes('Are you still there?'), 'Inactivity prompt was not played');
await waitFor(() => inactivityCompleted.length === 1, 'Inactive call was not closed');
assert.equal(inactivityCompleted[0].reason, 'inactivity_limit_reached');
assert.ok(inactivityTts.texts.includes('Thank you for calling. Goodbye.'));

console.log(JSON.stringify({ success: true, task: 'Real-time conversation orchestrator' }));
