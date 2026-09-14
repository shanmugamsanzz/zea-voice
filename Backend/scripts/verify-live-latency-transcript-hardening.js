import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env } from '../src/config/env.js';
import { CallController } from '../src/voice/call-controller.js';
import { configuredTtsFirstAudioTimeoutMs } from
  '../src/voice/realtime-conversation-orchestrator.js';
import { UNIVERSAL_TURN_LATENCY_BUDGET } from
  '../src/voice/interaction/universal-turn-latency-budget.js';

assert.deepEqual(UNIVERSAL_TURN_LATENCY_BUDGET, {
  totalFirstAudioMs: 3_000,
  retrievalMs: 150,
  llmFirstSentenceMs: 2_200,
  ttsFirstAudioMs: 500,
});
assert.equal(configuredTtsFirstAudioTimeoutMs(), 500);
assert.equal(configuredTtsFirstAudioTimeoutMs(275), 275);
assert.ok(env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS > env.VOICE_RETRIEVAL_TARGET_MS,
  'The retrieval performance target must remain separate from its operational timeout');
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
assert.match(orchestrator, /UNIVERSAL_TURN_LATENCY_BUDGET\.totalFirstAudioMs/u);
assert.match(orchestrator, /TTS_FIRST_AUDIO_TIMEOUT/u);
assert.match(orchestrator, /tts\.first_audio_fresh_connection_retry/u);
assert.match(orchestrator, /#createLookaheadTtsAdapter\(`\$\{generationId\}-fresh-retry`\)/u);
assert.match(orchestrator, /#primeTechnicalRecoveryAudio\(\)/u);
assert.match(orchestrator, /tts\.cached_technical_recovery_played/u);
assert.match(orchestrator,
  /error\?\.code\s*===\s*'VOICE_TURN_FIRST_AUDIO_DEADLINE'[\s\S]*#playCachedTechnicalRecovery/u,
  'Exhausting the shared budget must use cached audible recovery instead of disconnecting silently');

console.log(JSON.stringify({
  success: true,
  task: 'Bounded first-audio latency and interruption-safe transcript consistency',
}));
