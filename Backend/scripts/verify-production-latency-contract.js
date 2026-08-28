import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { task10Industries } from './fixtures/task-10-industries.js';
import { retrieveTargetedCandidates } from '../src/knowledge-engine/targeted-retrieval.js';
import { knowledgeSearchIndexes } from '../src/knowledge-engine/query-classifier.js';
import {
  VoiceTurnLatencyTracker,
  voiceTurnStages,
} from '../src/voice/interaction/grounded-turn-latency.js';
import { createSelectedLlmStream } from '../src/voice/providers/llm/llm-response.service.js';
import {
  evaluateFirstAudioSlo,
  voiceLatencyTargets,
} from '../src/voice/interaction/voice-latency-slo.js';
import { env } from '../src/config/env.js';
import {
  canonicalToolArguments,
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
      yield { type: 'text_delta', delta: '"stateUpdate":{},"decision":"CLARIFY",' };
      yield { type: 'text_delta', delta: '"answer":"","pendingQuestion":"Please clarify.","toolRequest":null,"clarification":{"reason":"missing_evidence"},"responseId":null}' };
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
for (let repeat = 1; repeat <= 3; repeat += 1) for (const fixture of task10Industries) {
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
  assert.match(streamed, /"decision":"CLARIFY"/u);
  await session.close();
}
assert.equal(providerRequests, task10Industries.length * 3,
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

const retrievalIdentity = {
  tenantId: '50000000-0000-4000-8000-000000000001',
  agentId: '50000000-0000-4000-8000-000000000002',
  callId: '50000000-0000-4000-8000-000000000003',
};
const retrievalInput = {
  ...retrievalIdentity, utterance: 'published choice', usageDirection: 'inbound',
};
const retrievalClassification = {
  ...retrievalIdentity,
  intentClass: 'KNOWN_INFORMATION',
  retrievalPlan: {
    indexes: [
      knowledgeSearchIndexes.CATALOG,
      knowledgeSearchIndexes.BM25,
      knowledgeSearchIndexes.SEMANTIC,
    ],
  },
};
const retrievalBundle = {
  tenantId: retrievalIdentity.tenantId,
  knowledgeBaseId: '50000000-0000-4000-8000-000000000004',
  publicationRevision: 1,
  assignedAgentIds: [retrievalIdentity.agentId],
  records: [{
    record_id: '50000000-0000-4000-8000-000000000005',
    record_type: 'catalog_item',
    usage_direction: 'both',
    entity_metadata: { itemKey: 'published-choice' },
  }],
};
const channelStarts = [];
const retrievalStartedAt = performance.now();
const parallel = await retrieveTargetedCandidates({
  input: retrievalInput,
  classification: retrievalClassification,
  resolution: { routingCandidates: [] },
  publicationBundles: [retrievalBundle],
  sparseIndexes: [{
    documents: [{
      id: retrievalBundle.records[0].record_id,
      recordType: 'CATALOG_ITEM',
      tenantId: retrievalIdentity.tenantId,
      knowledgeBaseId: retrievalBundle.knowledgeBaseId,
      publicationRevision: 1,
      usageDirection: 'both',
      tokens: ['published', 'choice'],
    }],
  }],
}, {
  onChannelStart: (channel) => channelStarts.push(channel),
  embed: async () => [0.1],
  search: async () => [{
    id: retrievalBundle.records[0].record_id,
    score: 0.92,
    payload: {
      tenant_id: retrievalIdentity.tenantId,
      knowledge_base_id: retrievalBundle.knowledgeBaseId,
      publication_revision: 1,
      record_type: 'CATALOG_ITEM',
      record_id: retrievalBundle.records[0].record_id,
      agent_usage: 'both',
    },
  }],
});
assert.deepEqual(new Set(channelStarts), new Set(['structured', 'bm25', 'qdrant']));
assert.ok(parallel.candidateCount >= 2);
assert.ok(performance.now() - retrievalStartedAt < 250);

const abortController = new AbortController();
const retrievalTracker = new VoiceTurnLatencyTracker({
  ...retrievalIdentity, turnId: 'bounded-retrieval',
});
await assert.rejects(() => retrievalTracker.measure(
  voiceTurnStages.RETRIEVAL,
  () => retrieveTargetedCandidates({
    input: { ...retrievalInput, abortSignal: abortController.signal },
    classification: retrievalClassification,
    resolution: { routingCandidates: [] },
    publicationBundles: [retrievalBundle],
  }, {
    embed: () => new Promise((resolve) => setTimeout(() => resolve([0.1]), 200)),
    search: async () => [],
  }),
  { timeoutMs: 20, cancel: () => abortController.abort('retrieval_deadline') },
), (error) => error.code === 'VOICE_TURN_STAGE_TIMEOUT');
assert.equal(abortController.signal.aborted, true);

const passingSamples = Array.from({ length: 20 }, (_, index) => ({ firstAudioMs: 500 + index * 10 }));
assert.equal(evaluateFirstAudioSlo(passingSamples).passed, true);
assert.ok(evaluateFirstAudioSlo(passingSamples).observed.p95 < 2_000);
assert.equal(evaluateFirstAudioSlo(passingSamples.slice(0, 5)).reason,
  'insufficient_production_samples');
assert.equal(voiceLatencyTargets.p90FirstAudioMs, 1_000);
assert.equal(env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000);
assert.equal(env.VOICE_RETRIEVAL_TARGET_MS, 150);
assert.ok(env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS > env.VOICE_RETRIEVAL_TARGET_MS);
assert.ok(env.VOICE_HYDRATION_TURN_TIMEOUT_MS > env.VOICE_RETRIEVAL_TARGET_MS);
assert.ok(env.VOICE_KNOWLEDGE_TURN_TIMEOUT_MS
  >= env.VOICE_RETRIEVAL_TURN_TIMEOUT_MS + env.VOICE_HYDRATION_TURN_TIMEOUT_MS,
  'The overall knowledge deadline must allow retrieval and hydration to complete');
assert.ok(env.VOICE_LLM_TURN_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);
assert.ok(env.VOICE_LLM_POST_ACK_TIMEOUT_MS > env.VOICE_LLM_TURN_TIMEOUT_MS);
assert.ok(env.VOICE_LLM_POST_ACK_TIMEOUT_MS >= 3000,
  'Post-acknowledgement completion needs production-latency headroom, not the fast test mock');
assert.ok(env.VOICE_LLM_POST_ACK_TIMEOUT_MS <= env.LLM_REQUEST_TIMEOUT_MS);
assert.ok(env.VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS < env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS);
assert.equal(remainingLiveTurnBudgetMs(2_000, 600, 0), 1_400);
const technicalFallback = configuredTechnicalFailureResponse({
  agent: {
    language: 'en',
    settings: { knowledgeClarificationMessage: "I didn't understand." },
  },
});
assert.doesNotMatch(technicalFallback, /didn'?t understand/iu);
assert.equal(technicalFallback, '',
  'The runtime must not invent caller-facing technical-failure speech');
assert.equal(configuredTechnicalFailureResponse({
  agent: { settings: { technicalFailureMessage: 'Configured technical response.' } },
}), 'Configured technical response.');
assert.deepEqual(canonicalToolArguments({
  name: 'tenant_action', arguments: { note: 'keep' },
}, [{
  name: 'tenant_action',
  inputSchema: { properties: {
    item_id: { type: 'string', format: 'catalog-reference' },
    item_name: {
      type: 'string', 'x-catalog-reference': true, 'x-catalog-value': 'name',
    },
  } },
}], { recordId: 'record-42', key: 'tenant-item', name: 'Tenant Item' }), {
  note: 'keep', item_id: 'record-42', item_name: 'Tenant Item',
});

const orchestrator = readFileSync(
  new URL('../src/voice/realtime-conversation-orchestrator.js', import.meta.url), 'utf8',
);
assert.match(orchestrator, /streaming\.onSentence\?\.\(sentence\)/u);
assert.match(orchestrator, /activeRetrievalAbortController\?\.abort\(reason\)/u);
assert.match(orchestrator, /LLM_REQUEST_TIMEOUT_MS|#llmAttempt/u);
assert.match(orchestrator, /VOICE_KNOWLEDGE_TURN_TIMEOUT_MS/u);
assert.match(orchestrator, /VOICE_RETRIEVAL_TARGET_MS/u);
assert.doesNotMatch(orchestrator,
  /RAG_RUNTIME_CHANNEL_DEADLINE_MS\s*\+\s*env\.RAG_RUNTIME_SEMANTIC_DEADLINE_MS/u,
  'Channel limits must not be added together as an artificial overall deadline');
assert.doesNotMatch(orchestrator,
  /VOICE_KNOWLEDGE_TURN_TIMEOUT_MS,[\s\S]{0,80}\b500\b/u,
  'Knowledge completion must not retain the obsolete 500 ms hard cap');
assert.match(orchestrator, /VOICE_LLM_TURN_TIMEOUT_MS/u);
assert.doesNotMatch(orchestrator, /postAcknowledgementTimeoutMs:\s*env\.VOICE_LLM_POST_ACK_TIMEOUT_MS/u,
  'The post-acknowledgement phase must retain the independent full completion deadline');
assert.match(orchestrator, /VOICE_TTS_FIRST_AUDIO_TIMEOUT_MS/u);
assert.match(orchestrator, /remainingLiveTurnBudgetMs/u);
assert.match(orchestrator,
  /Math\.min\(env\.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000\)/u,
  'The live first-audio deadline must stay capped at two seconds even with stale production env');
assert.match(orchestrator, /configuredTechnicalFailureResponse/u);
assert.match(orchestrator, /decisionWithoutRuntimeSpeech/u);
assert.doesNotMatch(orchestrator, /One moment while I check the published information/iu);
assert.doesNotMatch(orchestrator, /information service is temporarily unavailable/iu);
assert.match(orchestrator, /turn_first_audio_deadline/u);
assert.match(orchestrator, /voice\.late_validated_answer_continued/u,
  'a validated answer that finishes after the soft first-audio deadline must still be delivered');
assert.match(orchestrator, /options\.acknowledgement === true/u,
  'acknowledgement audio must be tracked independently from final response speech');
assert.match(orchestrator, /!acknowledgement && maximumResponseCharacters/u,
  'acknowledgement speech must not consume the validated response character budget');
assert.match(orchestrator, /activeGroundedTurnEpochs\.size > 0/u,
  'inactivity prompts must remain disabled throughout retrieval, LLM, validation and TTS');
const finalPipelineIndex = orchestrator.indexOf('const playback = await sentencePipeline.finish();');
const finalPlaybackCompleteIndex = orchestrator.indexOf(
  'await this.controller.playbackComplete();', finalPipelineIndex,
);
assert.ok(finalPipelineIndex >= 0 && finalPlaybackCompleteIndex > finalPipelineIndex,
  'listening and inactivity may resume only after final validated audio playback completes');
assert.doesNotMatch(orchestrator, /clarificationRecovery\?\.mode === 'suppressed'/u,
  'a valid grounded clarification must never be converted into silent listening');
assert.match(orchestrator,
  /currentSentenceNumber === 1[\s\S]{0,120}Date\.now\(\) < firstAudioDeadlineAt/u,
  'the hard first-audio deadline must apply only while it is still actionable');
assert.match(orchestrator, /persistAudible/u,
  'audible assistant speech must survive a confirmed interruption');
assert.match(orchestrator, /transcript\.audible_partial_persisted/u);

console.log('Production latency contract verification passed; real p90 remains production-sample gated.');
