import assert from 'node:assert/strict';
import {
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../src/knowledge-engine/engine-contract.js';
import { knowledgeQueryClasses } from '../src/knowledge-engine/query-classifier.js';
import {
  awaitLlmWithSafeLatency,
  runObservedKnowledgeTurn,
  safeLatencyAcknowledgement,
  VoiceTurnLatencyTracker,
  voiceTurnStages,
} from '../src/knowledge-engine/voice-turn-latency.js';

const identity = {
  tenantId: 'b0000000-0000-4000-8000-000000000001',
  agentId: 'b0000000-0000-4000-8000-000000000002',
  callId: 'b0000000-0000-4000-8000-000000000003',
  turnId: 'turn-1',
};

let now = 1_000;
const tracker = new VoiceTurnLatencyTracker(identity, {
  now: () => now, startedAt: now,
  knownAnswerTargetMs: 1_000, firstAudioDeadlineMs: 5_000,
});
assert.equal(tracker.firstAudioDeadlineMs, 2_000, 'Hard first-audio deadline must be capped at two seconds');
tracker.setKnownAnswer(true);
tracker.setResponseClass(
  `${knowledgeEngineDecisionTypes.RESPONSE}:${knowledgeEngineResponseModes.GROUNDED_LLM}`,
);
tracker.record(voiceTurnStages.STT_FINALIZATION, 75);
tracker.record(voiceTurnStages.ROUTING, 20);
tracker.record(voiceTurnStages.RETRIEVAL, 80);
tracker.record(voiceTurnStages.HYDRATION, 25);
now = 1_900;
tracker.record(voiceTurnStages.TTS_FIRST_CHUNK, 300);
tracker.record(voiceTurnStages.FIRST_AUDIO_DELIVERY, now - tracker.startedAt);
const knownSnapshot = tracker.snapshot();
assert.equal(knownSnapshot.firstAudioMs, 900);
assert.equal(knownSnapshot.firstAudioStatus, 'target_met');
assert.deepEqual(Object.keys(knownSnapshot.stages).sort(), [
  'firstAudioDeliveryMs', 'hydrationMs', 'retrievalMs', 'routingMs',
  'sttFinalizationMs', 'ttsFirstChunkMs',
]);

const immediateTracker = new VoiceTurnLatencyTracker({ ...identity, turnId: 'turn-2' });
const immediate = await awaitLlmWithSafeLatency(Promise.resolve('grounded answer'), {
  tracker: immediateTracker, acknowledgementAfterMs: 50,
});
assert.equal(immediate.value, 'grounded answer');
assert.equal(immediate.acknowledged, false);

const delayedTracker = new VoiceTurnLatencyTracker({ ...identity, turnId: 'turn-3' });
const acknowledgements = [];
const delayed = await awaitLlmWithSafeLatency(
  new Promise((resolve) => setTimeout(() => resolve('validated grounded answer'), 35)),
  {
    tracker: delayedTracker,
    acknowledgementAfterMs: 5,
    ttsReserveMs: 1,
    completionTimeoutMs: 200,
    acknowledgementText: 'Please wait while I check.',
    onAcknowledgement: async (text) => acknowledgements.push(text),
  },
);
assert.equal(delayed.acknowledged, true);
assert.equal(delayed.value, 'validated grounded answer');
assert.deepEqual(acknowledgements, ['Please wait while I check.']);
assert.equal(delayedTracker.snapshot().latencyAcknowledgement, true);
assert.doesNotMatch(safeLatencyAcknowledgement(), /unclear|understand/iu);

const ineligibleTracker = new VoiceTurnLatencyTracker({ ...identity, turnId: 'turn-3b' });
const suppressedAcknowledgements = [];
const ineligible = await awaitLlmWithSafeLatency(
  new Promise((resolve) => setTimeout(() => resolve('specific safe explanation'), 20)),
  {
    tracker: ineligibleTracker,
    acknowledgementEnabled: false,
    acknowledgementAfterMs: 2,
    completionTimeoutMs: 200,
    onAcknowledgement: async (text) => suppressedAcknowledgements.push(text),
  },
);
assert.equal(ineligible.acknowledged, false);
assert.equal(ineligible.value, 'specific safe explanation');
assert.deepEqual(suppressedAcknowledgements, []);
assert.equal(ineligibleTracker.snapshot().latencyAcknowledgement, false);

let cancelled = false;
await assert.rejects(() => awaitLlmWithSafeLatency(
  new Promise((resolve) => setTimeout(resolve, 200)),
  {
    tracker: new VoiceTurnLatencyTracker({ ...identity, turnId: 'turn-4' }),
    acknowledgementAfterMs: 2, ttsReserveMs: 1, completionTimeoutMs: 5,
    onAcknowledgement: async () => {},
    cancel: () => { cancelled = true; },
  },
), (error) => error.code === 'VOICE_TURN_STAGE_TIMEOUT');
assert.equal(cancelled, true);

let postAcknowledgementCancelled = false;
const completedAfterAcknowledgement = await awaitLlmWithSafeLatency(
  new Promise((resolve) => setTimeout(resolve, 200)),
  {
    tracker: new VoiceTurnLatencyTracker({ ...identity, turnId: 'turn-4b' }),
    acknowledgementAfterMs: 2,
    ttsReserveMs: 1,
    completionTimeoutMs: 500,
    postAcknowledgementTimeoutMs: 10,
    onAcknowledgement: async () => {},
    cancel: () => { postAcknowledgementCancelled = true; },
  },
);
assert.equal(completedAfterAcknowledgement.acknowledged, true);
assert.equal(postAcknowledgementCancelled, false,
  'Acknowledgement must not replace the independent LLM completion deadline');

const input = {
  tenantId: identity.tenantId, agentId: identity.agentId, callId: identity.callId,
  utterance: 'finalized tenant question', usageDirection: 'inbound',
};
const observedTracker = new VoiceTurnLatencyTracker({ ...identity, turnId: 'turn-5' });
const observed = await runObservedKnowledgeTurn({
  auth: { tenantId: identity.tenantId },
  input,
  publicationBundles: [{ tenantId: identity.tenantId }],
  runtimeProfile: { tools: [] },
  tracker: observedTracker,
}, {
  resolve: async () => ({
    tenantId: identity.tenantId, agentId: identity.agentId, callId: identity.callId,
    score: 0.98, action: 'CONTINUE',
  }),
  classify: async () => ({
    tenantId: identity.tenantId, agentId: identity.agentId, callId: identity.callId,
    intentClass: knowledgeQueryClasses.KNOWN_INFORMATION,
    requiresConfirmation: false, retrievalPlan: { indexes: ['ANSWER_CARD'] },
  }),
  retrieve: async () => ({
    tenantId: identity.tenantId, agentId: identity.agentId, callId: identity.callId,
    channels: { structured: [], bm25: [], qdrant: [] },
  }),
  hydrate: async () => ({
    tenantId: identity.tenantId, agentId: identity.agentId, callId: identity.callId,
    evidence: [], ambiguity: { detected: false }, conflict: { detected: false },
  }),
  plan: () => ({
    contractVersion: 1, type: knowledgeEngineDecisionTypes.CLARIFY,
    reason: 'fixture', confidence: 0, evidenceIds: [], response: null, tool: null,
    clarification: { kind: 'no_evidence', prompt: 'Please clarify.' },
  }),
});
assert.equal(observed.latency.knownAnswer, true);
assert.equal(observed.latency.responseClass, knowledgeEngineDecisionTypes.CLARIFY);
assert.ok(Number.isFinite(observed.latency.stages.routingMs));
assert.ok(Number.isFinite(observed.latency.stages.retrievalMs));
assert.ok(Number.isFinite(observed.latency.stages.hydrationMs));

console.log('New-engine stage observability, two-second deadline and safe LLM latency strategy verified.');
