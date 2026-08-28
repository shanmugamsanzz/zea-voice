import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env } from '../src/config/env.js';
import { CallController } from '../src/voice/call-controller.js';

assert.equal(env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000);
assert.ok(env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS > env.VOICE_RETRIEVAL_TARGET_MS,
  'The retrieval performance target must remain separate from its operational timeout');
assert.ok(env.VOICE_KNOWLEDGE_TURN_TIMEOUT_MS
  >= env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS + env.VOICE_HYDRATION_TURN_TIMEOUT_MS,
  'Knowledge completion must leave enough time for authoritative hydration');
assert.ok(env.VOICE_TTS_MAX_RESPONSE_CHARACTERS <= 600,
  'Live responses must remain short enough for conversational playback');

const persisted = [];
const controller = new CallController({
  callSession: { id: 'call-latency-transcript', providerCallId: 'provider-call' },
  runtimeProfile: {
    agent: {
      id: 'agent-1', settings: { greetingMode: 'user_initiates' },
      speech: { interaction: { greetingMode: 'user_initiates' } },
    },
  },
  hooks: { onTranscript: async (entry) => persisted.push(entry) },
});

await controller.initialize();
await controller.receiveFinalTranscript('Gold package details');
await controller.beginAssistantResponse();
await controller.recordAssistantMessage('Gold package starts with the approved details.');
await controller.interrupt('caller_barge_in');
await controller.receiveFinalTranscript('Silver package details');

assert.deepEqual(persisted.map(({ speaker, text }) => ({ speaker, text })), [
  { speaker: 'user', text: 'Gold package details' },
  { speaker: 'agent', text: 'Gold package starts with the approved details.' },
  { speaker: 'user', text: 'Silver package details' },
]);
assert.deepEqual(persisted.map((entry) => entry.sequenceNumber), [1, 2, 3],
  'Interrupted playback and the replacement caller turn must retain strict transcript order');

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /onFirstAudio/u);
assert.match(orchestrator, /persistAudible/u);
assert.match(orchestrator, /await this\.activeAssistantPlayback\?\.persistAudible\?\.\(reason\)/u);
assert.match(orchestrator, /sentencePipeline\.markTranscriptCommitted\(\)/u);
assert.match(orchestrator, /VOICE_TURN_FIRST_AUDIO_DEADLINE_MS/u);
assert.match(orchestrator, /TTS_FIRST_AUDIO_TIMEOUT/u);

console.log(JSON.stringify({
  success: true,
  task: 'Bounded first-audio latency and interruption-safe transcript consistency',
}));
