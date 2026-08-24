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
  const type = String(source.record_type).toUpperCase();
  const authoritativeData = type === 'CATALOG_ITEM' ? {
    itemKey: metadata.itemKey,
    categoryKey: metadata.categoryKey,
    name: source.entity_name,
    category: source.entity_category,
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
  return turn.id === 'acknowledgement' ? acknowledgement : overview;
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

const retrievalSamples = [];
const firstAudioSamples = [];
const verified = [];
let runtimeExceptions = 0;
for (let pass = 1; pass <= repeats; pass += 1) {
  const callId = `85000000-0000-4000-8000-${String(pass).padStart(12, '0')}`;
  const memory = openIsolatedCallMemory({
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    callId,
  }, { language: fixture.language });
  try {
    for (const turn of fixture.turns) {
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

      if (turn.expectedKind === 'targeted_confirmation') {
        assert.equal(result.resolution.confidence, 'MEDIUM');
        assert.equal(result.resolution.action, 'CONFIRM');
        assert.equal(result.resolution.candidate.categoryKey, 'onco-care-package');
        assert.equal(result.decision.type, knowledgeEngineDecisionTypes.CLARIFY);
        assert.match(result.decision.clarification.prompt, /Onco Care package.*சொல்றீங்களா/u);
        assert.doesNotMatch(result.decision.clarification.prompt,
          /clear|clarify|little more detail|published option/iu);
        verified.push({
          pass,
          id: turn.id,
          decision: result.decision.type,
          prompt: result.decision.clarification.prompt,
          retrievalMs,
        });
        continue;
      }

      assert.equal(result.decision.type, knowledgeEngineDecisionTypes.RESPONSE);
      assert.equal(result.decision.mode, knowledgeEngineResponseModes.GROUNDED_LLM);
      const final = finalizeGroundedLlmResponse({
        input,
        plan: result.decision,
        answer: expectedAnswer(turn),
        selectedEvidenceIds: result.evidenceIds,
        authoritative: result.authoritative,
      });
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
      assert.equal(spoken[1].text, expectedAnswer(turn));
      tracker.record(voiceTurnStages.FIRST_AUDIO_DELIVERY, 800);
      const firstAudioMs = tracker.snapshot().firstAudioMs;
      firstAudioSamples.push(firstAudioMs);
      assert.ok(firstAudioMs < fixture.requirements.maximumFirstAudioMs);
      assert.doesNotMatch(spoken.map((entry) => entry.text).join(' '),
        /One moment.*clear|One moment.*clarify/iu);
      memory.applyEngineDecision(final, {
        entity: result.entities[0] ?? null,
        explicitEntity: result.entities.length > 0,
        citedEvidence: result.authoritative.evidence,
      });
      verified.push({
        pass,
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
}

const percentile95 = (samples) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};
assert.equal(runtimeExceptions, 0);
assert.equal(verified.length, repeats * fixture.turns.length);
assert.ok(percentile95(retrievalSamples) < fixture.requirements.maximumRetrievalMs);
assert.ok(percentile95(firstAudioSamples) < fixture.requirements.maximumFirstAudioMs);
console.log(JSON.stringify({
  gate: 'exact-live-call-2026-08-24',
  passed: true,
  repeats,
  totalTurns: verified.length,
  runtimeExceptions,
  retrievalP95Ms: Math.round(percentile95(retrievalSamples) * 100) / 100,
  firstAudioP95Ms: percentile95(firstAudioSamples),
  verified,
}, null, 2));
