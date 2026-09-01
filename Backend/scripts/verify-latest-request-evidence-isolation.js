import assert from 'node:assert/strict';
import { fuseCandidateRankings } from '../src/knowledge-engine/authoritative-evidence.js';

const scope = Object.freeze({
  tenantId: 'latest-request-tenant',
  agentId: 'latest-request-agent',
  callId: 'latest-request-call',
});
const candidate = (recordId, recordType, score, extra = {}) => Object.freeze({
  ...scope,
  recordId,
  recordType,
  knowledgeBaseId: 'latest-request-kb',
  publicationRevision: 9,
  callerFacingHint: recordType !== 'WORKFLOW_RULE' || extra.callerFacingHint === true,
  score,
  ...extra,
});
const focused = candidate('catalog-focused', 'CATALOG_ITEM', 1);
const unrelatedCatalog = candidate('catalog-unrelated', 'CATALOG_ITEM', 0.99);
const relevantFaq = candidate('faq-relevant', 'FAQ', 0.96);
const relevantGeneral = candidate('general-relevant', 'KNOWLEDGE_CHUNK', 0.95);
const internalWorkflow = candidate('workflow-internal', 'WORKFLOW_RULE', 0.99);
const callerWorkflow = candidate('workflow-caller', 'WORKFLOW_RULE', 0.97, {
  callerFacingHint: true,
});

function retrieval({ reservations, intentClass = 'DETAILS_OR_PRICE', need = {} } = {}) {
  const channel = (name, values) => Object.freeze(values.map((value, index) => Object.freeze({
    ...value, channel: name, rank: index + 1, namespaceRank: index + 1,
  })));
  return Object.freeze({
    ...scope,
    intentClass,
    recordTypes: Object.freeze([
      'CATALOG_ITEM', 'FAQ', 'WORKFLOW_RULE', 'KNOWLEDGE_CHUNK',
    ]),
    primaryNamespaces: Object.freeze(['CATALOG']),
    queryContext: Object.freeze({
      reservedRecords: Object.freeze(reservations),
      need: Object.freeze(need),
    }),
    channels: Object.freeze({
      structured: channel('structured', [focused]),
      bm25: channel('bm25', [
        unrelatedCatalog, relevantFaq, relevantGeneral, internalWorkflow, callerWorkflow,
      ]),
      qdrant: channel('qdrant', [
        unrelatedCatalog, relevantFaq, relevantGeneral, internalWorkflow, callerWorkflow,
      ]),
    }),
  });
}

const focusedReservation = Object.freeze({
  recordId: focused.recordId,
  recordType: focused.recordType,
  reason: 'explicit_entity',
});
const focusedFusion = fuseCandidateRankings(retrieval({
  reservations: [focusedReservation],
}), { limit: 5, minProviderScore: 0, highProviderScore: 0.86 });
assert.equal(focusedFusion.candidates[0].recordId, focused.recordId);
assert.equal(focusedFusion.candidates.some((entry) => (
  entry.recordId === unrelatedCatalog.recordId
)), false, 'A sibling Catalog record must not enter a focused entity turn');
assert.equal(focusedFusion.candidates.some((entry) => (
  entry.recordId === internalWorkflow.recordId
)), false, 'Internal Workflow evidence must not enter the caller-facing top five');
assert.equal(focusedFusion.candidates.some((entry) => (
  entry.recordId === callerWorkflow.recordId
)), false, 'Unreserved Workflow evidence must not enter the grounded package');
assert.deepEqual(focusedFusion.rejectedUnrelatedCatalogIds, [unrelatedCatalog.recordId]);
assert.deepEqual(focusedFusion.rejectedUnrelatedWorkflowIds, [
  internalWorkflow.recordId, callerWorkflow.recordId,
]);
assert.ok(focusedFusion.candidates.length < 5,
  'Five records are a maximum; unrelated records must not be used as padding');

const applicableWorkflowFusion = fuseCandidateRankings(retrieval({
  reservations: [
    focusedReservation,
    { recordId: callerWorkflow.recordId, recordType: 'WORKFLOW_RULE', reason: 'latest_request_record' },
  ],
}), { limit: 5, minProviderScore: 0, highProviderScore: 0.86 });
assert.equal(applicableWorkflowFusion.candidates.some((entry) => (
  entry.recordId === callerWorkflow.recordId
)), true, 'An applicable reserved Workflow must remain available for authorization');

const topFaq = candidate('faq-latest', 'FAQ', 0.99);
const unrelatedFaq = candidate('faq-unrelated', 'FAQ', 0.88);
const latestIntentFusion = fuseCandidateRankings(Object.freeze({
  ...scope,
  intentClass: 'KNOWN_INFORMATION',
  recordTypes: Object.freeze(['FAQ']),
  primaryNamespaces: Object.freeze(['FAQ']),
  queryContext: Object.freeze({ reservedRecords: Object.freeze([]), need: Object.freeze({}) }),
  channels: Object.freeze({
    structured: Object.freeze([]),
    bm25: Object.freeze([]),
    qdrant: Object.freeze([
      Object.freeze({ ...topFaq, channel: 'qdrant', rank: 1, namespaceRank: 1 }),
      Object.freeze({ ...unrelatedFaq, channel: 'qdrant', rank: 2, namespaceRank: 2 }),
    ]),
  }),
}), {
  limit: 5, minProviderScore: 0.64, highProviderScore: 0.86, relevanceScoreMargin: 0.06,
});
assert.deepEqual(latestIntentFusion.candidates.map((entry) => entry.recordId), [
  topFaq.recordId,
], 'Only records inside the latest-request relevance band may reach hydration');
assert.deepEqual(latestIntentFusion.rejectedBelowRelevanceBandIds, [
  unrelatedFaq.recordId,
]);

const comparisonFusion = fuseCandidateRankings(retrieval({
  intentClass: 'COMPARISON_COMPLEX',
  reservations: [
    { ...focusedReservation, reason: 'explicit_comparison' },
    { recordId: unrelatedCatalog.recordId, recordType: 'CATALOG_ITEM', reason: 'explicit_comparison' },
  ],
}), { limit: 5, minProviderScore: 0, highProviderScore: 0.86 });
assert.deepEqual(comparisonFusion.candidates.slice(0, 2).map((entry) => entry.recordId), [
  focused.recordId, unrelatedCatalog.recordId,
], 'Every explicit comparison record must remain reserved before ordinary evidence');

const recommendationFusion = fuseCandidateRankings(retrieval({
  reservations: [focusedReservation],
  need: { requestedRecommendation: true },
}), { limit: 5, minProviderScore: 0, highProviderScore: 0.86 });
assert.equal(recommendationFusion.candidates.some((entry) => (
  entry.recordId === unrelatedCatalog.recordId
)), true, 'A tenant-driven recommendation may retain multiple relevant Catalog options');

console.log(JSON.stringify({
  gate: 'latest-request-evidence-isolation',
  passed: true,
  focusedCatalogIsolation: true,
  workflowIsolation: true,
  applicableWorkflowReservation: true,
  latestRequestRelevanceBand: true,
  comparisonReservationsPreserved: true,
  recommendationCandidatesPreserved: true,
  maximumVerifiedRecords: 5,
}, null, 2));
