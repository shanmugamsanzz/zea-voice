import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { task10Industries } from './fixtures/task-10-industries.js';
import { runParallelHybridRetrieval } from '../src/knowledge-bases/parallel-hybrid-retrieval.js';
import { createSelectedLlmStream } from '../src/voice/providers/llm/llm-response.service.js';
import {
  evaluateFirstAudioSlo,
  voiceLatencyTargets,
} from '../src/voice/interaction/voice-latency-slo.js';
import { env } from '../src/config/env.js';
import {
  configuredTechnicalFailureResponse,
  remainingLiveTurnBudgetMs,
} from '../src/voice/realtime-conversation-orchestrator.js';

assert.equal(task10Industries.length, 5);
assert.ok(new Set(task10Industries.map((fixture) => fixture.industry)).size === 5);
assert.ok(new Set(task10Industries.map((fixture) => fixture.language)).has('ta'));
assert.ok(new Set(task10Industries.map((fixture) => fixture.language)).has('en'));

let providerRequests = 0;
let maximumOutputTokens = null;
let maximumPromptCharacters = 0;
let maximumHistoryMessages = 0;
let cancellations = 0;
const adapter = {
  stream(input) {
    providerRequests += 1;
    maximumOutputTokens = input.maxOutputTokens;
    maximumPromptCharacters = Math.max(maximumPromptCharacters,
      String(input.messages?.[0]?.content ?? '').length);
    maximumHistoryMessages = Math.max(maximumHistoryMessages,
      Math.max(0, Number(input.messages?.length ?? 0) - 2));
    return (async function* events() {
      yield { type: 'text_delta', delta: '{"evidenceIds":[],' };
      yield { type: 'text_delta', delta: '"stateUpdate":{},"decision":"clarify",' };
      yield { type: 'text_delta', delta: '"answer":"I need one detail.","pendingQuestion":"Please clarify.","toolRequest":null}' };
      yield { type: 'completed', toolCalls: [], usage: {} };
    }());
  },
  cancel() { cancellations += 1; },
  close() {},
};
const profile = {
  agent: {
    id: 'agent-a', name: 'Configured Agent', description: '', goal: 'Use approved evidence',
    language: 'Multilingual', prompt: 'Answer naturally.', temperature: 0, settings: {},
  },
  providers: {
    llm: { providerId: 'provider-a', providerName: 'test', modelId: 'model-a', modelKey: 'test' },
  },
  tools: [],
};
for (const fixture of task10Industries) {
  const session = await createSelectedLlmStream(profile, {
    callId: `call-${fixture.industry}`,
    query: fixture.query,
    history: [{ role: 'assistant', content: 'Previous configured question.' }],
    usageDirection: 'inbound',
    knowledge: { found: true, route: 'test', content: fixture.fact },
    context: { groundedResponseMode: true, liveCallMemory: { currentTopic: fixture.industry } },
  }, { adapter, skipDefaultRegistration: true });
  let streamed = '';
  for await (const event of session.events) {
    if (event.type === 'text_delta') streamed += event.delta;
  }
  assert.match(streamed, /"decision":"clarify"/u);
  await session.close();
}
assert.equal(providerRequests, task10Industries.length,
  'each ordinary turn must make exactly one streamed LLM request');
assert.equal(maximumOutputTokens, 384,
  'live grounded decisions must honor the voice-specific output cap');
assert.ok(maximumPromptCharacters <= 8_000,
  'live grounded prompts must honor the compact voice budget');
assert.ok(maximumHistoryMessages <= 4,
  'live grounded prompts must retain at most four recent history messages');

const cancelledSession = await createSelectedLlmStream(profile, {
  callId: 'call-cancel', query: 'new topic', history: [], usageDirection: 'inbound',
  knowledge: { found: false }, context: { groundedResponseMode: true },
}, { adapter, skipDefaultRegistration: true });
await cancelledSession.cancel('stale_turn');
assert.equal(cancellations, 1);

const retrievalStartedAt = performance.now();
const bounded = await runParallelHybridRetrieval({
  bm25: () => ({ id: 'local-result' }),
  vector: () => new Promise(() => {}),
}, { defaultDeadlineMs: 80 });
assert.equal(bounded.candidates.length, 1);
assert.ok(bounded.failures.some((failure) => failure.code === 'RETRIEVAL_CHANNEL_DEADLINE'));
assert.ok(performance.now() - retrievalStartedAt < 250);

const abortController = new AbortController();
const abortedWork = runParallelHybridRetrieval({
  vector: () => new Promise(() => {}),
}, { defaultDeadlineMs: 500, signal: abortController.signal });
abortController.abort('barge_in');
const aborted = await abortedWork;
assert.ok(aborted.failures.some((failure) => failure.code === 'RETRIEVAL_CHANNEL_ABORTED'));

const passingSamples = Array.from({ length: 20 }, (_, index) => ({ firstAudioMs: 500 + index * 10 }));
assert.equal(evaluateFirstAudioSlo(passingSamples).passed, true);
assert.equal(evaluateFirstAudioSlo(passingSamples.slice(0, 5)).reason,
  'insufficient_production_samples');
assert.equal(voiceLatencyTargets.p90FirstAudioMs, 1_000);
assert.equal(env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000);
assert.ok(env.VOICE_KNOWLEDGE_TURN_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);
assert.ok(env.VOICE_LLM_TURN_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);
assert.ok(env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);
assert.equal(remainingLiveTurnBudgetMs(2_000, 600, 0), 1_400);
const technicalFallback = configuredTechnicalFailureResponse({
  agent: {
    language: 'en',
    settings: { knowledgeClarificationMessage: "I didn't understand." },
  },
});
assert.doesNotMatch(technicalFallback, /didn'?t understand/iu);
assert.match(technicalFallback, /temporarily unavailable/iu);

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /streaming\.onSentence\?\.\(sentence\)/u);
assert.match(orchestrator, /activeRetrievalAbortController\?\.abort\(reason\)/u);
assert.match(orchestrator, /LLM_REQUEST_TIMEOUT_MS|#llmAttempt/u);
assert.match(orchestrator, /VOICE_KNOWLEDGE_TURN_TIMEOUT_MS/u);
assert.match(orchestrator, /VOICE_LLM_TURN_TIMEOUT_MS/u);
assert.match(orchestrator, /VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS/u);
assert.match(orchestrator, /remainingLiveTurnBudgetMs/u);
assert.match(orchestrator,
  /Math\.min\(env\.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000\)/u,
  'The live first-audio deadline must stay capped at two seconds even with stale production env');
assert.match(orchestrator, /configuredTechnicalFailureResponse/u);
assert.match(orchestrator, /turn_first_audio_deadline/u);
assert.match(orchestrator, /persistAudible/u,
  'audible assistant speech must survive a confirmed interruption');
assert.match(orchestrator, /transcript\.audible_partial_persisted/u);

console.log('Production latency contract verification passed; real p90 remains production-sample gated.');
