import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env } from '../src/config/env.js';
import { CallController } from '../src/voice/call-controller.js';
import { configuredTtsFirstAudioTimeoutMs } from
  '../src/voice/realtime-conversation-orchestrator.js';

assert.equal(configuredTtsFirstAudioTimeoutMs(), env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS);
for (const removed of ['VOICE_FIRST_AUDIO_TARGET_MS', 'VOICE_TURN_FIRST_AUDIO_DEADLINE_MS',
  'VOICE_RETRIEVAL_TARGET_MS', 'VOICE_RETRIEVAL_TURN_TIMEOUT_MS',
  'VOICE_LLM_TURN_TIMEOUT_MS']) {
  assert.equal(Object.hasOwn(env, removed), false,
    `${removed} must not impose a fixed latency target`);
}
assert.equal(Object.hasOwn(env, 'VOICE_TTS_MAX_RESPONSE_CHARACTERS'), false,
  'Per-agent UI configuration must be the only spoken response character limit');
assert.equal(Object.hasOwn(env, 'VOICE_LLM_MAX_OUTPUT_TOKENS'), false,
  'The LLM allowance must be derived from the per-agent UI speech limit');

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
assert.doesNotMatch(orchestrator, /UNIVERSAL_TURN_LATENCY_BUDGET/u,
  'A fixed aggregate latency budget must not cancel normal provider work');
assert.match(orchestrator, /TTS_FIRST_AUDIO_TIMEOUT/u);
assert.match(orchestrator, /tts\.first_audio_fresh_connection_retry/u);
assert.match(orchestrator, /#createLookaheadTtsAdapter\(`\$\{generationId\}-fresh-retry`\)/u);
assert.match(orchestrator, /#primeTechnicalRecoveryAudio\(\)/u);
assert.match(orchestrator, /tts\.cached_technical_recovery_played/u);
assert.match(orchestrator, /env\.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS/u,
  'TTS failure detection must use the configured provider timeout');

console.log(JSON.stringify({
  success: true,
  task: 'Provider-configured latency and interruption-safe transcript consistency',
}));
