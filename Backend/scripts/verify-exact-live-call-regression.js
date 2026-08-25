import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { buildPublicationIndexes } from '../src/knowledge-engine/publication-index-builder.js';
import {
  createKnowledgeEngineInput,
  knowledgeEngineDecisionTypes,
  knowledgeEngineResponseModes,
} from '../src/knowledge-engine/engine-contract.js';
import { finalizeGroundedLlmResponse } from '../src/knowledge-engine/safe-response-tool-runtime.js';
import { retrieveTenantEvidence } from '../src/knowledge-engine/runtime-service.js';
import {
  buildRevisionSparseIndex,
  cacheCompactKnowledgeMap,
} from '../src/knowledge-bases/knowledge-map.service.js';
import { openIsolatedCallMemory } from '../src/knowledge-engine/call-memory.js';
import { compactBundleAsKnowledge } from '../src/knowledge-engine/compact-evidence-bundle.js';
import { buildGroundingEnvelope } from '../src/voice/interaction/grounded-llm-response.js';
import { hydrateGroundingEnvelope } from '../src/voice/interaction/grounded-claim-validator.js';
import { validateEvidenceScope } from '../src/voice/interaction/grounded-decision-security.js';
import {
  awaitLlmWithSafeLatency,
  VoiceTurnLatencyTracker,
  voiceTurnStages,
} from '../src/knowledge-engine/voice-turn-latency.js';
import { FramedAudioQueue } from '../src/voice/audio/framed-audio-queue.js';
import { AudioPacer } from '../src/voice/audio/audio-pacer.js';

const fixture = JSON.parse(await readFile(new URL(
  '../fixtures/exact-live-call-2026-08-24-regression.json', import.meta.url,
), 'utf8'));
const repeatsArgument = process.argv.find((value) => value.startsWith('--repeats='));
const repeats = Number(repeatsArgument?.split('=')[1] ?? fixture.requirements.repeats);
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 20);
assert.deepEqual(fixture.turns.map((turn) => turn.utterance), [
  'சொல்லுங்க', 'என்ன packagesலாம் இருக்கு?', 'On Cooker package',
]);

const identity = Object.freeze({
  tenantId: '81000000-0000-4000-8000-000000000001',
  agentId: '81000000-0000-4000-8000-000000000002',
  knowledgeBaseId: '81000000-0000-4000-8000-000000000003',
  publicationRevision: 1,
});
const overview = 'எங்களிடம் Wellness மற்றும் Onco Care packages உள்ளன.';
const acknowledgement = 'சரிங்க. எங்களிடம் உள்ள approved packages பற்றி சொல்லலாம்.';
const phoneticAnswer = 'Onco Care package-ல் Onco Care First மற்றும் Onco Care Second உள்ளன.';
const identityAnswer = 'நான் இந்த tenant-ன் published AI voice assistant.';
const purposeAnswer = 'Published services பற்றிய தகவல் வழங்கவும், configured actions-க்கு உதவவும் பேசுகிறேன்.';
const latestOverview = 'எங்களிடம் Wellness, Onco Care மற்றும் Organ-Specific packages உள்ளன.';
const organSpecificAnswer = 'Organ-Specific package. Approved organ-specific screening options. Available options: Organ Option One, Organ Option Two.';

function record(index, values) {
  const suffix = String(index).padStart(12, '0');
  return Object.freeze({
    record_id: `82000000-0000-4000-8000-${suffix}`,
    record_type: values.type,
    document_id: `83000000-0000-4000-8000-${suffix}`,
    document_version_id: `84000000-0000-4000-8000-${suffix}`,
    usage_direction: 'both',
    language: fixture.language,
    source_page_start: 1,
    source_page_end: 1,
    question: values.question,
    answer: values.answer,
    content: values.answer,
    entity_name: values.name,
    entity_category: values.category ?? null,
    entity_aliases: values.aliases ?? [],
    entity_category_aliases: values.categoryAliases ?? [],
    entity_metadata: values.metadata ?? {},
  });
}

const records = Object.freeze([
  record(1, {
    type: 'conversation_node',
    question: fixture.turns[0].utterance,
    answer: acknowledgement,
    name: 'Published acknowledgement response',
    aliases: [fixture.turns[0].utterance],
    metadata: { conditions: { intentClass: 'ACKNOWLEDGEMENT' } },
  }),
  record(2, {
    type: 'conversation_node',
    question: fixture.turns[1].utterance,
    answer: overview,
    name: 'Published category overview',
    aliases: [fixture.turns[1].utterance],
    metadata: { conditions: { intentClass: 'CATEGORY_OVERVIEW' } },
  }),
  record(3, {
    type: 'catalog_item',
    question: 'Onco Care First',
    answer: 'Onco Care First has its published screening details.',
    name: 'Onco Care First',
    category: 'Onco Care package',
    aliases: ['Onco Care First'],
    categoryAliases: ['Onco Care package', 'Onco package'],
    metadata: {
      itemKey: 'onco-care-first',
      categoryKey: 'onco-care-package',
      description: 'Published first screening details.',
      selectionRules: { selectable: true },
    },
  }),
  record(4, {
    type: 'catalog_item',
    question: 'Onco Care Second',
    answer: 'Onco Care Second has its published screening details.',
    name: 'Onco Care Second',
    category: 'Onco Care package',
    aliases: ['Onco Care Second'],
    categoryAliases: ['Onco Care package', 'Onco package'],
    metadata: {
      itemKey: 'onco-care-second',
      categoryKey: 'onco-care-package',
      description: 'Published second screening details.',
      selectionRules: { selectable: true },
    },
  }),
  record(5, {
    type: 'catalog_item',
    question: 'Wellness Choice',
    answer: 'Wellness Choice has its published details.',
    name: 'Wellness Choice',
    category: 'Wellness package',
    aliases: ['Wellness Choice'],
    categoryAliases: ['Wellness package', 'packages'],
    metadata: {
      itemKey: 'wellness-choice',
      categoryKey: 'wellness-package',
      description: 'Published wellness details.',
      selectionRules: { selectable: true },
    },
  }),
  record(6, {
    type: 'faq',
    question: 'Who are you?',
    answer: identityAnswer,
    name: 'Published identity answer',
    aliases: ['யாருங்க நீங்க?', 'Who are you?'],
    metadata: { conditions: { intentClass: 'KNOWN_INFORMATION' } },
  }),
  record(7, {
    type: 'conversation_node',
    question: 'Why are you calling?',
    answer: purposeAnswer,
    name: 'Published call purpose',
    aliases: ['எதுக்கு phone பண்ணிருக்கீங்க?', 'Why are you calling?'],
    metadata: { conditions: { intentClass: 'KNOWN_INFORMATION' } },
  }),
  record(8, {
    type: 'conversation_node',
    question: 'What packages are available?',
    answer: latestOverview,
    name: 'Published complete overview',
    aliases: ['உங்ககிட்ட என்ன packagesலாம் இருக்கு?', 'What packages are available?'],
    metadata: { conditions: { intentClass: 'CATEGORY_OVERVIEW' } },
  }),
  record(9, {
    type: 'catalog_item',
    question: 'Organ Option One',
    answer: 'Organ Option One has approved screening details.',
    name: 'Organ Option One',
    category: 'Organ-Specific package',
    aliases: ['Organ Option One'],
    categoryAliases: ['Organ-Specific package'],
    metadata: {
      itemKey: 'organ-option-one',
      categoryKey: 'organ-specific-package',
      categoryDescription: 'Approved organ-specific screening options.',
      description: 'Approved first organ screening details.',
      selectionRules: { selectable: true },
    },
  }),
  record(10, {
    type: 'catalog_item',
    question: 'Organ Option Two',
    answer: 'Organ Option Two has approved screening details.',
    name: 'Organ Option Two',
    category: 'Organ-Specific package',
    aliases: ['Organ Option Two'],
    categoryAliases: ['Organ-Specific package'],
    metadata: {
      itemKey: 'organ-option-two',
      categoryKey: 'organ-specific-package',
      categoryDescription: 'Approved organ-specific screening options.',
      description: 'Approved second organ screening details.',
      selectionRules: { selectable: true },
    },
  }),
]);
const job = Object.freeze({
  tenant_id: identity.tenantId,
  knowledge_base_id: identity.knowledgeBaseId,
  targetRevision: identity.publicationRevision,
  knowledge_base_usage: 'both',
  assigned_agent_ids: [identity.agentId],
});
const bundle = buildPublicationIndexes(job, records);
const sparse = buildRevisionSparseIndex(job, bundle.records);
const recordsById = new Map(records.map((entry) => [entry.record_id, entry]));
const cacheValues = new Map();
const cache = Object.freeze({
  status: 'ready',
  async get(key) { return cacheValues.get(key) ?? null; },
  async set(key, value) { cacheValues.set(key, value); return 'OK'; },
  async del(...keys) {
    let deleted = 0;
    for (const key of keys) deleted += cacheValues.delete(key) ? 1 : 0;
    return deleted;
  },
});
await cacheCompactKnowledgeMap(job, bundle.records, cache, bundle);

function hydratedRow(candidate) {
  const source = recordsById.get(String(candidate.record_id));
  if (!source) return null;
  const metadata = source.entity_metadata ?? {};
  const type = String(candidate.record_type ?? source.record_type).toUpperCase();
  const authoritativeData = type === 'CATALOG_CATEGORY' ? {
    categoryKey: candidate.category_key ?? metadata.categoryKey,
    category: source.entity_category,
    categoryDescription: metadata.categoryDescription,
    children: records.filter((entry) => (
      String(entry.record_type).toUpperCase() === 'CATALOG_ITEM'
      && entry.entity_metadata?.categoryKey === (candidate.category_key ?? metadata.categoryKey)
    )).map((entry) => ({
      recordId: entry.record_id,
      itemKey: entry.entity_metadata?.itemKey,
      name: entry.entity_name,
      description: entry.entity_metadata?.description,
    })),
  } : type === 'CATALOG_ITEM' ? {
    itemKey: metadata.itemKey,
    categoryKey: metadata.categoryKey,
    name: source.entity_name,
    category: source.entity_category,
    categoryDescription: metadata.categoryDescription,
    description: metadata.description,
    sourceText: source.answer,
    selectionRules: metadata.selectionRules,
  } : {
    content: source.answer,
    conditions: metadata.conditions,
  };
  return {
    record_type: type,
    record_id: source.record_id,
    knowledge_base_id: candidate.knowledge_base_id,
    publication_revision: candidate.publication_revision,
    document_id: source.document_id,
    document_version_id: source.document_version_id,
    document_name: 'exact-live-call-fixture.txt',
    document_display_name: 'Exact Live Call Fixture',
    document_type: 'txt',
    document_status: 'ready',
    document_version_status: 'ready',
    document_version_is_current: true,
    source_page_start: 1,
    source_page_end: 1,
    language: source.language,
    content: source.answer,
    caller_facing: true,
    authoritative_data: authoritativeData,
    rank: candidate.rank,
    rrf_score: candidate.rrf_score,
  };
}

function contextRunner(_auth, operation) {
  return operation({
    query: async (_sql, parameters) => {
      if (parameters.length === 3) return { rows: [{
        knowledge_base_id: identity.knowledgeBaseId,
        publication_revision: identity.publicationRevision,
        priority: 1,
      }] };
      const requested = JSON.parse(parameters[3]);
      return { rows: requested.map(hydratedRow).filter(Boolean) };
    },
  });
}

function expectedAnswer(turn) {
  if (turn.id === 'acknowledgement') return acknowledgement;
  if (turn.id === 'phonetic-entity' || turn.contextDependent) return phoneticAnswer;
  if (turn.id === 'identity') return identityAnswer;
  if (turn.id === 'purpose') return purposeAnswer;
  if (turn.id === 'latest-overview') return latestOverview;
  if (turn.id === 'resolved-category') return organSpecificAnswer;
  return overview;
}

function validateFullEvidence(result) {
  const scope = {
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    requireHydratedEvidence: true,
    publicationRevisions: [{
      knowledgeBaseId: identity.knowledgeBaseId,
      publicationRevision: identity.publicationRevision,
    }],
  };
  for (const source of result.authoritative.evidence) {
    assert.deepEqual(validateEvidenceScope(source, scope), { valid: true, reason: null });
  }
  if (!result.llmEvidenceBundle) return;
  const compact = compactBundleAsKnowledge({
    tenantEvidence: {
      llmEvidenceBundle: result.llmEvidenceBundle,
      publicationRevisions: scope.publicationRevisions,
    },
  });
  const envelope = buildGroundingEnvelope(compact, {
    includePublishedMap: false,
    maximumSources: 5,
  });
  const hydrated = hydrateGroundingEnvelope(envelope, result.authoritative.evidence);
  assert.equal(hydrated.sources.length > 0, true);
  for (const source of hydrated.sources) {
    assert.deepEqual(validateEvidenceScope(source, scope), { valid: true, reason: null });
    const mapped = envelope.sourceMap.find((entry) => entry.sourceId === source.id);
    assert.equal(mapped?.publishedEvidenceId, source.publishedEvidenceId);
    assert.equal(mapped?.recordId, source.recordId);
  }
}

async function verifyContinuousSentenceAudio(playbackGroupId) {
  const queue = new FramedAudioQueue({
    maxFrames: 24, maxBytes: 24_000, maxBufferedMs: 2_000,
  });
  const metrics = [];
  let sentenceFailures = 0;
  const enqueueFrames = async (generationId, value, count, chunkDelayMs = 0) => {
    try {
      for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
        if (chunkDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        }
        await queue.enqueue({
          data: Buffer.alloc(160, value), durationMs: 20, generationId,
          playbackGroupId, cancellationVersion: 0,
        });
      }
    } catch (error) {
      sentenceFailures += 1;
      throw error;
    }
  };
  // Pre-buffer the first sentence, then deliver the look-ahead sentence as
  // delayed streaming chunks while Plivo pacing is already active.
  await enqueueFrames('sentence-1', 1, 16);
  const pacer = new AudioPacer({
    queue,
    send: async () => ({ deliveryMs: 0, bufferedAmountAfter: 0 }),
    shouldSend: () => true,
    packetDurationMs: 80,
    preRollMs: 120,
    preRollMaxWaitMs: 20,
    lowWaterMs: 60,
    deliveryLeadMs: 160,
    onPlaybackMetric: (metric) => metrics.push(metric),
  });
  pacer.start();
  const delayedLookahead = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await enqueueFrames('sentence-2', 2, 12, 5);
  })();
  await Promise.all([delayedLookahead, pacer.drain()]);
  queue.close();
  await pacer.stop();
  return Object.freeze({
    underruns: metrics.filter((metric) => metric.type === 'underrun').length,
    sentenceFailures,
  });
}

const retrievalSamples = [];
const firstAudioSamples = [];
const verified = [];
let runtimeExceptions = 0;
let falseAmbiguities = 0;
let groundingRejections = 0;
let memoryFollowUps = 0;
let audioUnderruns = 0;
let ttsSentenceFailures = 0;
let delayedLlmTurns = 0;
const acknowledgementToAnswerSamples = [];
// The observed utterances belong only to this regression fixture. Runtime
// matching continues to come entirely from the publication indexes above.
const calls = Object.freeze([
  Object.freeze({ id: 'observed-call-1', turns: Object.freeze([...fixture.turns]) }),
  Object.freeze({ id: 'observed-call-2', turns: Object.freeze([
    Object.freeze({
      id: 'category-overview', utterance: fixture.turns[1].utterance, expectedKind: 'response',
    }),
    Object.freeze({
      id: 'phonetic-entity', utterance: fixture.turns[2].utterance, expectedKind: 'response',
    }),
    Object.freeze({
      id: 'contextual-follow-up', utterance: 'What options are in this package?',
      expectedKind: 'response', contextDependent: true, expectedFromTurnId: 'phonetic-entity',
    }),
  ]) }),
  Object.freeze({ id: 'observed-call-3', turns: Object.freeze([
    Object.freeze({
      id: 'identity', utterance: 'யாருங்க நீங்க?', expectedKind: 'response',
    }),
    Object.freeze({
      id: 'purpose', utterance: 'எதுக்கு phone பண்ணிருக்கீங்க?', expectedKind: 'response',
    }),
    Object.freeze({
      id: 'latest-overview', utterance: 'உங்ககிட்ட என்ன packagesலாம் இருக்கு?', expectedKind: 'response',
    }),
    Object.freeze({
      id: 'resolved-category', utterance: 'Organ-Specific package பத்தி சொல்லுங்க',
      expectedKind: 'response',
    }),
  ]) }),
]);
assert.equal(calls.length, 3, 'The regression must preserve two prior calls and the latest live call');
for (let pass = 1; pass <= repeats; pass += 1) {
  for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
    const call = calls[callIndex];
    const callId = `85000000-0000-4000-8000-${String(pass * 10 + callIndex).padStart(12, '0')}`;
    const memory = openIsolatedCallMemory({
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      callId,
    }, { language: fixture.language });
    try {
      for (const turn of call.turns) {
      const input = createKnowledgeEngineInput({
        tenantId: identity.tenantId,
        agentId: identity.agentId,
        callId,
        utterance: turn.utterance,
        language: fixture.language,
        usageDirection: 'inbound',
        memory: memory.snapshot(),
      });
      const startedAt = performance.now();
      let result;
      try {
        result = await retrieveTenantEvidence({ tenantId: identity.tenantId }, input, {
          cache,
          contextRunner,
          runtimeProfile: { tools: [] },
          throwOnError: true,
          retrievalDependencies: {
            embed: async () => [0.1, 0.2],
            search: async () => [],
          },
        });
      } catch (error) {
        runtimeExceptions += 1;
        throw error;
      }
      const retrievalMs = performance.now() - startedAt;
      retrievalSamples.push(retrievalMs);
      assert.ok(retrievalMs < fixture.requirements.maximumRetrievalMs,
        `pass ${pass}, ${turn.id}: retrieval took ${retrievalMs.toFixed(2)}ms`);
      assert.doesNotMatch(String(result.decision.reason), /foreign_evidence_selected/iu);
      validateFullEvidence(result);
      assert.ok(result.retrievalTrace.retrievedCandidates.length > 0);
      assert.ok(result.retrievalTrace.hydratedEvidence.length > 0);
      assert.deepEqual(result.retrievalTrace.permittedEvidenceIds, result.evidenceIds);
      assert.equal(result.retrievalTrace.sourceMap.every((entry, index) => (
        entry.sourceId === `source_${index + 1}`
        && result.retrievalTrace.hydratedEvidence.some((source) => (
          source.recordId === entry.recordId && source.evidenceId === entry.publishedEvidenceId
        ))
      )), true);

      if (turn.id === 'phonetic-entity') {
        assert.equal(result.resolution.confidence, 'MEDIUM');
        assert.equal(result.resolution.action, 'CONFIRM');
        assert.equal(result.resolution.candidate.categoryKey, 'onco-care-package');
        assert.equal(result.authoritative.ambiguity.detected, false);
      }

      if (result.authoritative.ambiguity.detected) falseAmbiguities += 1;

      assert.equal(result.decision.type, knowledgeEngineDecisionTypes.RESPONSE,
        `${call.id}, ${turn.id}: ${JSON.stringify({
          reason: result.decision.reason,
          resolution: result.resolution,
          entities: result.entities,
          memory: memory.snapshot(),
        })}`);
      const final = result.decision.mode === knowledgeEngineResponseModes.DETERMINISTIC
        ? result.decision
        : finalizeGroundedLlmResponse({
          input,
          plan: result.decision,
          answer: expectedAnswer(turn),
          selectedEvidenceIds: result.evidenceIds,
          authoritative: result.authoritative,
        });
      if (final.type !== knowledgeEngineDecisionTypes.RESPONSE) groundingRejections += 1;
      assert.equal(final.type, knowledgeEngineDecisionTypes.RESPONSE);
      assert.equal(final.response.text, expectedAnswer(turn));
      assert.doesNotMatch(String(final.reason), /foreign_evidence_selected/iu);

      const tracker = new VoiceTurnLatencyTracker({
        tenantId: identity.tenantId,
        agentId: identity.agentId,
        callId,
        turnId: `${pass}-${turn.id}`,
      });
      const spoken = [];
      if (result.decision.mode === knowledgeEngineResponseModes.GROUNDED_LLM) {
        const delayed = await awaitLlmWithSafeLatency(
          new Promise((resolve) => setTimeout(() => resolve(final.response.text), 15)),
          {
            tracker,
            acknowledgementAfterMs: 2,
            ttsReserveMs: 1,
            completionTimeoutMs: 200,
            acknowledgementText: 'One moment while I check.',
            onAcknowledgement: async (text) => spoken.push({ type: 'acknowledgement', text }),
          },
        );
        assert.equal(delayed.acknowledged, true);
        spoken.push({ type: 'final', text: delayed.value });
        assert.deepEqual(spoken.map((entry) => entry.type), ['acknowledgement', 'final']);
      } else {
        spoken.push({ type: 'final', text: final.response.text });
        assert.deepEqual(spoken.map((entry) => entry.type), ['final']);
      }
      assert.equal(spoken.at(-1).text, expectedAnswer(turn));
      tracker.record(voiceTurnStages.FIRST_AUDIO_DELIVERY, 800);
      const firstAudioMs = tracker.snapshot().firstAudioMs;
      firstAudioSamples.push(firstAudioMs);
      assert.ok(firstAudioMs < fixture.requirements.maximumFirstAudioMs);
      assert.doesNotMatch(spoken.map((entry) => entry.text).join(' '),
        /One moment.*clear|One moment.*clarify/iu);
      const resolvedCandidate = result.resolution?.candidate ?? null;
      const resolvedCategorySource = result.authoritative.evidence.find((source) => (
        source.recordType === 'CATALOG_CATEGORY'
        && source.recordId === final.response?.recordId
      )) ?? null;
      const memoryCategory = resolvedCandidate?.entityType === 'CATEGORY' ? {
        id: resolvedCategorySource?.recordId ?? final.response?.recordId ?? null,
        recordId: resolvedCategorySource?.recordId ?? final.response?.recordId ?? null,
        key: resolvedCategorySource?.authoritativeData?.categoryKey
          ?? resolvedCandidate.categoryKey,
        name: resolvedCategorySource?.authoritativeData?.category
          ?? resolvedCandidate.label,
        description: resolvedCategorySource?.authoritativeData?.categoryDescription
          ?? resolvedCandidate.categoryDescription,
      } : null;
      memory.applyEngineDecision(final, {
        entity: memoryCategory ? null : (result.entities[0] ?? null),
        category: memoryCategory,
        explicitEntity: !memoryCategory && result.entities.length > 0,
        explicitCategory: Boolean(memoryCategory),
        citedEvidence: result.authoritative.evidence,
      });
      if (turn.id === 'resolved-category') {
        assert.equal(memory.snapshot().activeCategory?.id, final.response.recordId);
        assert.equal(memory.snapshot().activeEntity, null);
      }
      if (turn.contextDependent) {
        memoryFollowUps += 1;
        assert.equal(result.resolution.contextDependent, true,
          `${call.id}, ${turn.id}: the follow-up did not use current-call memory ${JSON.stringify({
            resolution: result.resolution, memory: input.memory,
          })}`);
        const prior = verified.findLast((entry) => (
          entry.pass === pass && entry.callId === call.id && entry.id === turn.expectedFromTurnId
        ));
        assert.ok(prior, `${call.id}, ${turn.id}: prior entity turn was not retained`);
        assert.equal(final.response.text, prior.answer,
          `${call.id}, ${turn.id}: contextual follow-up changed the resolved answer`);
      }
      verified.push({
        pass,
        callId: call.id,
        id: turn.id,
        decision: final.type,
        answer: final.response.text,
        retrievalMs,
        firstAudioMs,
      });
      }
    } finally {
      memory.close();
    }
    const audio = await verifyContinuousSentenceAudio(`${pass}-${call.id}`);
    audioUnderruns += audio.underruns;
    ttsSentenceFailures += audio.sentenceFailures;
  }
  const delayedTracker = new VoiceTurnLatencyTracker({
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    callId: `delayed-llm-${pass}`,
    turnId: String(pass),
  });
  let acknowledgedAt = null;
  const delayedStartedAt = performance.now();
  const delayedLlm = await awaitLlmWithSafeLatency(
    new Promise((resolve) => setTimeout(() => resolve('validated delayed answer'), 650)),
    {
      tracker: delayedTracker,
      acknowledgementAfterMs: 300,
      ttsReserveMs: 200,
      completionTimeoutMs: 2_000,
      acknowledgementText: 'Configured tenant latency acknowledgement.',
      onAcknowledgement: async () => { acknowledgedAt = performance.now(); },
    },
  );
  const completedAt = performance.now();
  assert.equal(delayedLlm.acknowledged, true);
  assert.equal(delayedLlm.value, 'validated delayed answer');
  assert.ok(acknowledgedAt !== null);
  const acknowledgementToAnswerMs = completedAt - acknowledgedAt;
  acknowledgementToAnswerSamples.push(acknowledgementToAnswerMs);
  assert.ok(acknowledgementToAnswerMs < 500,
    `pass ${pass}: acknowledgement-to-answer gap was ${acknowledgementToAnswerMs.toFixed(2)}ms`);
  assert.ok(acknowledgedAt - delayedStartedAt < 2_000);
  delayedLlmTurns += 1;
}

const percentile95 = (samples) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};
assert.equal(runtimeExceptions, 0);
assert.equal(falseAmbiguities, 0);
assert.equal(groundingRejections, 0);
assert.equal(memoryFollowUps, repeats);
assert.equal(audioUnderruns, 0);
assert.equal(ttsSentenceFailures, 0);
assert.equal(delayedLlmTurns, repeats);
assert.equal(verified.length, repeats * calls.reduce((total, call) => total + call.turns.length, 0));
assert.ok(percentile95(retrievalSamples) < fixture.requirements.maximumRetrievalMs);
assert.ok(percentile95(firstAudioSamples) < fixture.requirements.maximumFirstAudioMs);
console.log(JSON.stringify({
  gate: 'real-streaming-live-call-production-regression',
  passed: true,
  repeats,
  totalTurns: verified.length,
  callsPerPass: calls.length,
  runtimeExceptions,
  falseAmbiguities,
  groundingRejections,
  memoryFollowUps,
  audioUnderruns,
  ttsSentenceFailures,
  delayedLlmTurns,
  acknowledgementToAnswerP95Ms:
    Math.round(percentile95(acknowledgementToAnswerSamples) * 100) / 100,
  retrievalP95Ms: Math.round(percentile95(retrievalSamples) * 100) / 100,
  firstAudioP95Ms: percentile95(firstAudioSamples),
  verified,
}, null, 2));
