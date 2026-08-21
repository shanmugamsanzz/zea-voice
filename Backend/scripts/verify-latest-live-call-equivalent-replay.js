import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolveCatalogEntityLocally } from '../src/knowledge-bases/catalog-entity-resolver.js';
import {
  authoritativeEvidenceFromRow,
  groundedLlmReasoningRequired,
  resolveConfidenceResponseRoute,
  selectDeterministicEvidenceResponse,
  selectStrongCallerMessage,
} from '../src/knowledge-bases/hybrid-knowledge-retrieval.service.js';
import { env } from '../src/config/env.js';
import { validateFinalCustomerTurn } from '../src/voice/interruption/final-turn-validator.js';
import { latestTurnWorkflowActivation } from '../src/knowledge-bases/workflow-activation-policy.js';

const fixture = JSON.parse(await readFile(new URL(
  '../fixtures/latest-live-call-2026-08-21-regression.json', import.meta.url,
), 'utf8'));

const identity = Object.freeze({
  tenantId: 'tenant-live-equivalent', agentId: 'agent-live-equivalent',
});

function hydratedEvidence({ recordId, recordType, content, authoritativeData, rank = 1 }) {
  return Object.freeze({
    ...authoritativeEvidenceFromRow({
      record_type: recordType,
      record_id: recordId,
      tenant_id: identity.tenantId,
      agent_id: identity.agentId,
      knowledge_base_id: 'kb-live-equivalent',
      publication_revision: 1,
      document_id: `document-${recordId}`,
      document_version_id: `version-${recordId}`,
      document_name: 'published-tenant-data',
      language: 'ta',
      content,
      caller_facing: true,
      authoritative_data: authoritativeData,
      score: 0.99 - rank * 0.01,
      rank,
    }),
    semanticScore: 0.99 - rank * 0.01,
    semanticRank: rank,
    lexicalScore: 8,
    tokenCoverage: 0.9,
    retrievalScore: 0.98 - rank * 0.01,
    retrievalContext: 'primary',
    channels: Object.freeze(['semantic', 'bm25']),
  });
}

function catalogItem({ recordId, itemKey, name, aliases, category, categoryKey,
  categoryAliases, description, rank }) {
  const authoritativeData = Object.freeze({
    itemKey, name, aliases, category, categoryKey, categoryAliases,
    description, sourceText: `${name}. ${description}`,
    attributes: Object.freeze([]), relationships: Object.freeze({}),
    selectionRules: Object.freeze({ selectable: true }),
  });
  const evidence = hydratedEvidence({
    recordId, recordType: 'CATALOG_ITEM', content: authoritativeData.sourceText,
    authoritativeData, rank,
  });
  return Object.freeze({
    evidence,
    identity: Object.freeze({ id: recordId, recordId, ...authoritativeData }),
  });
}

const categorySttAliases = Object.freeze([
  'onco package', 'onco care', 'onco care package',
  'ஆண் கோ package', 'ஆண் கோ care health package',
]);
const catalog = Object.freeze([
  catalogItem({
    recordId: 'catalog-silver', itemKey: 'silver-master-health-checkup',
    name: 'Silver Master Health Checkup', aliases: ['silver', 'silver package'],
    category: 'Master Health Check-up', categoryKey: 'master-health-checkup',
    categoryAliases: ['master package'], description: 'Approved Silver package information.', rank: 1,
  }),
  catalogItem({
    recordId: 'catalog-gold', itemKey: 'gold-master-health-checkup',
    name: 'Gold Master Health Checkup', aliases: ['gold', 'gold package'],
    category: 'Master Health Check-up', categoryKey: 'master-health-checkup',
    categoryAliases: ['master package'], description: 'Approved Gold package information.', rank: 2,
  }),
  catalogItem({
    recordId: 'catalog-onco-male', itemKey: 'onco-care-premium-male',
    name: 'Cancer Screening Male', aliases: ['male cancer screening'],
    category: 'Oncology Screening', categoryKey: 'oncology-screening',
    categoryAliases: categorySttAliases, description: 'Approved male oncology option.', rank: 3,
  }),
  catalogItem({
    recordId: 'catalog-onco-female', itemKey: 'onco-care-premium-female',
    name: 'Cancer Screening Female', aliases: ['female cancer screening'],
    category: 'Oncology Screening', categoryKey: 'oncology-screening',
    categoryAliases: categorySttAliases, description: 'Approved female oncology option.', rank: 4,
  }),
  catalogItem({
    recordId: 'catalog-kids', itemKey: 'pediatric-health-screening',
    name: 'Pediatric Health Screening', aliases: ['kids health screening'],
    category: 'Pediatric Health Screening', categoryKey: 'pediatric-health-screening',
    categoryAliases: ['kids package', 'kids health package'],
    description: 'Approved pediatric screening information.', rank: 5,
  }),
  catalogItem({
    recordId: 'catalog-child-development', itemKey: 'child-development-screening',
    name: 'Child Development Screening', aliases: ['development screening'],
    category: 'Pediatric Health Screening', categoryKey: 'pediatric-health-screening',
    categoryAliases: ['kids package', 'kids health package'],
    description: 'Approved child development option.', rank: 6,
  }),
]);

const catalogEvidence = Object.freeze(catalog.map((entry) => entry.evidence));
const catalogIdentities = Object.freeze(catalog.map((entry) => entry.identity));
const overview = hydratedEvidence({
  recordId: 'conversation-package-overview', recordType: 'CONVERSATION_NODE',
  content: 'Approved tenant package overview.',
  authoritativeData: Object.freeze({
    nodeType: 'message', nodeKey: 'package-overview',
    variables: Object.freeze([
      Object.freeze({ key: 'situation', value: 'The caller accepts the pending offer.' }),
      Object.freeze({ key: 'context', value: 'pending package-information offer' }),
      Object.freeze({ key: 'examples', value: ['ஆமாங்க'] }),
    ]),
  }),
});
const timingFaq = hydratedEvidence({
  recordId: 'faq-hospital-timing', recordType: 'FAQ',
  content: 'Approved tenant opening-hours response.',
  authoritativeData: Object.freeze({
    question: 'hospital timing open', answer: 'Approved tenant opening-hours response.',
  }),
});

let llmInvocationsForKnownEvidence = 0;
let llmTimeouts = 0;
let genericClarifications = 0;
const results = [];

function assertApprovedResponse(turn, response, expectedEvidenceIds, startedAt) {
  assert.ok(response?.content, `${turn.id}: approved response missing`);
  const evidenceIds = response.deterministicEvidenceIds ?? [response.id];
  const evidenceRegistry = [...catalogEvidence, overview, timingFaq];
  const selectedRecordIds = new Set([
    response.recordId,
    ...evidenceIds.map((evidenceId) => evidenceRegistry
      .find((source) => source.id === evidenceId)?.recordId),
  ].filter(Boolean));
  for (const expected of expectedEvidenceIds) {
    assert.ok(selectedRecordIds.has(expected),
      `${turn.id}: expected evidence ${expected} was not selected`);
  }
  const route = resolveConfidenceResponseRoute({
    directMessage: response, evidence: [response], reasoningRequired: false,
  });
  assert.equal(route.outcome, 'direct', `${turn.id}: known request must use direct routing`);
  assert.equal(groundedLlmReasoningRequired({
    evidence: [response], directResponse: response,
  }), false, `${turn.id}: deterministic response must not require the LLM`);
  const firstAudioMs = performance.now() - startedAt;
  assert.ok(firstAudioMs < fixture.requirements.maximumFirstAudioMs,
    `${turn.id}: first audio exceeded ${fixture.requirements.maximumFirstAudioMs}ms`);
  for (const clarification of fixture.genericClarifications) {
    if (response.content.toLocaleLowerCase().includes(clarification.toLocaleLowerCase())) {
      genericClarifications += 1;
    }
  }
  results.push(Object.freeze({
    id: turn.id, route: route.outcome, evidenceIds: Object.freeze([...evidenceIds]),
    firstAudioMs: Number(firstAudioMs.toFixed(2)), llmInvoked: false,
  }));
}

for (const turn of fixture.turns) {
  const startedAt = performance.now();
  const stt = validateFinalCustomerTurn({
    text: turn.utterance, minimumWords: turn.kind === 'acknowledgement' ? 1 : 2,
    acknowledgementPhrases: ['ஆமாங்க', 'ஆம்', 'yes'], rejectAcknowledgement: false,
  });
  assert.equal(stt.accepted, true, `${turn.id}: valid finalized STT was rejected`);

  if (turn.kind === 'acknowledgement') {
    const routed = selectStrongCallerMessage([{ ...overview, retrievalContext: 'contextual' }],
      turn.utterance, {
        pendingQuestion: fixture.pendingQuestion,
        understanding: {
          requestType: 'positive_acknowledgement', contextDependent: true,
          explicitEntities: [], requestedFacts: [], constraints: [], contextualReferences: [],
        },
        knownEntities: [],
      });
    const selected = selectDeterministicEvidenceResponse({
      directMessage: routed ?? overview, evidence: [overview], query: turn.utterance,
    });
    assert.equal(selected?.recordId, turn.expectedRecordId);
    assertApprovedResponse(turn, selected, [turn.expectedRecordId], startedAt);
    continue;
  }

  if (turn.kind === 'item' || turn.kind === 'category') {
    const resolution = resolveCatalogEntityLocally(catalogIdentities, turn.utterance);
    assert.equal(resolution?.status, 'match', `${turn.id}: explicit tenant entity was not resolved`);
    assert.equal(resolution.entityType, turn.kind, `${turn.id}: wrong entity type`);
    const selectedIdentities = turn.kind === 'item' ? [resolution.item] : resolution.items;
    const selectedIds = selectedIdentities.map((item) => item.id);
    if (turn.kind === 'item') assert.equal(resolution.item.itemKey, turn.expectedItemKey);
    else assert.equal(resolution.categoryKey, turn.expectedCategoryKey);
    const response = selectDeterministicEvidenceResponse({
      evidence: catalogEvidence.filter((source) => selectedIds.includes(source.recordId)),
      query: turn.utterance,
      catalogIdentityResolution: resolution,
      explicitCatalogRecordIds: selectedIds,
    });
    assertApprovedResponse(turn, response, selectedIds, startedAt);
    continue;
  }

  if (turn.kind === 'faq') {
    const response = selectDeterministicEvidenceResponse({
      evidence: [timingFaq], query: turn.utterance,
    });
    assert.equal(response?.recordId, turn.expectedRecordId);
    assertApprovedResponse(turn, response, [turn.expectedRecordId], startedAt);
    continue;
  }

  if (turn.kind === 'booking') {
    const activation = latestTurnWorkflowActivation({
      latestUtterance: turn.utterance,
      conditions: { examples: [turn.utterance, 'Please book an appointment'] },
    });
    assert.equal(activation.allowed, true, `${turn.id}: configured Workflow did not activate`);
    const resolution = resolveCatalogEntityLocally(catalogIdentities, turn.utterance);
    assert.equal(resolution?.item?.itemKey, turn.expectedItemKey,
      `${turn.id}: booking must retain the explicitly selected item`);
    assert.equal(turn.requiresConfirmation, true);
    assert.equal(turn.requiresVerifiedToolSuccess, true);
  } else {
    const confirmation = latestTurnWorkflowActivation({
      latestUtterance: turn.utterance,
      conditions: { examples: [turn.utterance, 'Yes, confirm the request'] },
    });
    assert.equal(confirmation.allowed, true,
      `${turn.id}: configured confirmation phrase was not accepted`);
    assert.equal(turn.expectedIntent, 'confirmation');
  }
  const firstAudioMs = performance.now() - startedAt;
  assert.ok(firstAudioMs < fixture.requirements.maximumFirstAudioMs);
  results.push(Object.freeze({
    id: turn.id, route: turn.kind, evidenceIds: Object.freeze([]),
    firstAudioMs: Number(firstAudioMs.toFixed(2)), llmInvoked: false,
  }));
}

assert.equal(llmInvocationsForKnownEvidence, 0);
assert.equal(llmTimeouts, fixture.requirements.maximumKnownRequestLlmTimeouts);
assert.equal(genericClarifications, 0,
  'Valid finalized STT must never receive the generic clarification response');
assert.ok(fixture.turns.filter((turn) => turn.interruptedPreviousAudio).length >= 4,
  'Latest-call replay must include repeated barge-in/topic-switch turns');
assert.equal(Math.min(env.VOICE_TURN_FIRST_AUDIO_DEADLINE_MS, 2_000), 2_000);

console.log(JSON.stringify({
  task: 'latest-live-call-equivalent-replay', passed: true,
  turns: results.length,
  knownEvidenceLlmInvocations: llmInvocationsForKnownEvidence,
  knownRequestLlmTimeouts: llmTimeouts,
  genericClarificationsForValidStt: genericClarifications,
  maximumFirstAudioMs: Math.max(...results.map((result) => result.firstAudioMs)),
  firstAudioLimitMs: fixture.requirements.maximumFirstAudioMs,
  interruptionTurns: fixture.turns.filter((turn) => turn.interruptedPreviousAudio).length,
  evidenceSelections: results.map(({ id, route, evidenceIds }) => ({ id, route, evidenceIds })),
}, null, 2));
