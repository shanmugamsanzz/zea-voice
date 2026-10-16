import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= 'localhost';
process.env.TTS_SPEED_MONITOR_ENABLED = 'false';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
const { RealtimeConversationOrchestrator, attachRealtimeConversationOrchestrator } = await import('../src/voice/realtime-conversation-orchestrator.js');
const { transferRuntimes, notifyVerifiedTransferHangup } = await import('../src/voice/transfer-runtime-registry.js');
const call = { id: '11111111-1111-4111-8111-111111111111', tenantId: 'tenant-a', workspaceId: 'workspace-a',
  agentId: 'agent-a', providerCallId: '22222222-2222-4222-8222-222222222222',
  from: '+919000000001', to: '+918000000001', direction: 'inbound' };
const log = { info() {}, warn() {}, error() {}, debug() {} };
const ticks = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Runtime did not reach the expected state');
};
class Media extends EventEmitter {
  constructor() { super(); this.call = call; this.callId = call.id; this.providerCallId = call.providerCallId;
    this.started = true; this.closed = false; this.transport = 'plivo'; this.log = log; }
  clearAudio() {}
  checkpoint(name) { this.checkpointName = name; }
  close() { this.closed = true; this.emit('stop'); this.emit('closed', { code: 1000, reason: 'test_stream_closed' }); }
}
let resumed = 0; let finalized = 0; let sttConnections = 0; let paused = 0;
const closedProviders = [];
const requests = []; const transcripts = []; const played = [];
const transferService = { available: async () => true,
  register: entry => transferRuntimes.set(entry.call.id, entry),
  unregister: id => transferRuntimes.delete(id),
  resumed: async () => { resumed++; }, callerHangup: async () => {},
};
const audio = { start() {}, cancelStaleAudio: () => ({ removedFrames: 0 }),
  pauseForTransfer: async () => { paused++; }, beginOutputGeneration() {},
  enqueueSynthesized: async () => true, flushSynthesized: async () => {}, drainOutput: async () => {}, close: async () => {},
  stopPlaybackPacing: async () => {},
};
const original = new Media();
const runtime = new RealtimeConversationOrchestrator(original, {
  logger: log, callTransferService: transferService,
  loadProfile: async () => ({ agent: { id: call.agentId, tenantId: call.tenantId, workspaceId: call.workspaceId,
    prompt: 'Help the caller. Preserve their patient details. Never promise an unsaved callback.',
    welcomeMessage: 'Original welcome must not replay.', language: 'English', settings: { cachePolicy: 'disabled', greetingMode: 'user_initiates' },
    inactivityTimeoutSeconds: 0 }, tools: [], providers: { stt: { modelKey: 'fake-stt' }, llm: { modelKey: 'fake-llm' }, tts: { modelKey: 'fake-tts' } } }),
  loadRuntimeAmbience: async () => null, createAudioEngine: () => audio,
  appendTranscript: async entry => { transcripts.push(entry); },
  createAdapters: async () => ({ stt: { connect: async () => { sttConnections++; }, cancel() {}, close() { closedProviders.push('stt'); }, onEvent: () => () => {} },
    llm: { cancel() {}, close() { closedProviders.push('llm'); }, async *stream(request) { requests.push(request);
      yield { type: 'text_delta', delta: 'The team could not answer. Can I help with anything else?' };
      yield { type: 'completed', usage: { inputTokens: 12, outputTokens: 3 } };
    } },
    tts: { cancel() {}, close() { closedProviders.push('tts'); }, async *synthesizeStream({ text }) { played.push(text);
      yield { type: 'audio_chunk', audio: Buffer.alloc(160) }; yield { type: 'completed', usage: { audioOutputMs: 20 } };
    } },
  }),
  completeCall: async () => { finalized++; },
});
await runtime.ready;
await runtime.controller.initialize(); runtime.mediaStartedAt = Date.now();
await runtime.controller.receiveFinalTranscript('Patient Surya from Salem has leg pain.');
await runtime.controller.setAssistantResponse('Shall I transfer you to staff?');
await runtime.controller.playbackComplete();
await runtime.controller.receiveFinalTranscript('Yes, transfer me.');
const controller = runtime.controller; const memory = runtime.liveCallMemory; const usage = runtime.usageTracker;
const before = runtime.controller.history;
const entry = transferRuntimes.get(call.id);
let pauseFinished = false;
const announcement = 'Hospital team-kitta connect panna try panren nga. Konjam line-la wait pannunga.';
const pause = entry.pause({ announcement, requireAnnouncement: true }).then(() => { pauseFinished = true; });
await ticks(() => Boolean(original.checkpointName));
assert.equal(played[0], announcement);
assert.equal(pauseFinished, false, 'Local TTS drain must not finish the transfer preamble without provider ACK');
original.emit('playedStream', { name: 'another-checkpoint' });
assert.equal(pauseFinished, false);
original.emit('playedStream', { name: original.checkpointName });
await pause; await entry.detach();
assert.equal(paused, 2); assert.equal(runtime.finalized, false);
assert.equal(finalized, 0, 'An intentional stream stop must not complete/bill the caller call');
assert.equal(original.transferPending, true);
assert.deepEqual(runtime.controller.history.slice(0, before.length), before);
assert.equal(runtime.controller.history.at(-1).content, announcement);
entry.resumeResult = { verified: true, transferId: 'attempt-a', status: 'busy', mode: 'wait_and_return', connected: false, callbackSaved: false };
const replacement = new Media();
assert.equal(attachRealtimeConversationOrchestrator(replacement), runtime);
replacement.emit('start');
await ticks(() => played.length === 2 && runtime.controller.state === 'listening');
assert.equal(resumed, 1); assert.equal(sttConnections, 2);
assert.equal(runtime.controller, controller); assert.equal(runtime.liveCallMemory, memory);
assert.equal(runtime.usageTracker, usage); assert.equal(audio.mediaSession, replacement);
assert.equal(requests.length, 1); assert.equal(played.length, 2);
assert.match(JSON.stringify(requests[0].messages), /Patient Surya from Salem has leg pain/);
assert.match(requests[0].messages.at(-1).content, /"status":"busy"/);
assert.match(runtime.transferFollowUp.promptContext(runtime.runtimeProfile.tools), /"status":"busy"/);
assert.match(runtime.transferFollowUp.promptContext(runtime.runtimeProfile.tools), /No staff callback action is configured/);
assert.doesNotMatch(played[1], /welcome|vanakkam|hello/i);
assert.equal(runtime.finalized, false);
await entry.pause(); await entry.bridged();
assert.deepEqual(closedProviders.sort(), ['llm', 'stt', 'tts'], 'Staff answer releases AI provider connections');
assert.equal(runtime.finalized, false, 'Releasing AI providers must not complete the phone call');
await notifyVerifiedTransferHangup(call.providerCallId, 'other-company');
assert.equal(finalized, 0, 'Another company cannot terminate this retained runtime');
await notifyVerifiedTransferHangup(call.providerCallId, call.tenantId);
assert.equal(finalized, 1); assert.equal(transferRuntimes.has(call.id), false);
console.log('Real orchestrator resume passed: intentional stream stop preserves call, same controller/memory/usage reused, verified result and history reach LLM, no greeting, STT reconnect, staff-only AI pause and tenant-bound hangup cleanup. Media/providers are mocked.');
