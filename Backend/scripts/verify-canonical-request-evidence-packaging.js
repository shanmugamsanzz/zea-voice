import assert from 'node:assert/strict';
import { collectCanonicalRetrievalReservations } from '../src/knowledge-engine/canonical-retrieval-reservations.js';
import { buildContextEnrichedRetrievalQuery } from '../src/knowledge-engine/targeted-retrieval.js';
import { buildGroundedLlmInput } from '../src/knowledge-bases/grounded-turn-evidence.js';

const scope = [{ id: 'kb-a', publicationRevision: 4 }];
const memoryRecord = { recordId: 'record-memory', name: 'Published Alpha' };
const explicitRecord = { recordId: 'record-current', recordType: 'CATALOG_ITEM', name: 'Published Beta' };
const baseInput = {
  tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
  usageDirection: 'inbound', latestQuestion: 'What is its configured value?',
  utterance: 'What is its configured value?', requestedFacts: ['configured_value'],
  memory: { activeEntity: memoryRecord, knownEntities: [memoryRecord] },
  canonicalCallMemory: { activeEntity: memoryRecord, knownEntities: [memoryRecord] },
  queryUnderstanding: {
    explicitEntities: [], explicitCategories: [], comparisonEntities: [],
    requestedFacts: ['configured_value'], contextDependent: true,
    canonicalContext: { ...memoryRecord, recordType: 'CATALOG_ITEM' },
  },
};
const classification = { retrievalPlan: { namespace: 'CATALOG' } };
const contextual = buildContextEnrichedRetrievalQuery(
  baseInput, classification, { contextDependent: true }, scope,
);
assert.equal(contextual.canonicalEntity.recordId, memoryRecord.recordId);
assert.equal(contextual.reservedRecords[0].reason, 'canonical_memory');
assert.match(contextual.semanticText, /Published Alpha/u);
assert.match(contextual.semanticText, /configured_value/u);

const explicit = buildContextEnrichedRetrievalQuery({
  ...baseInput,
  latestQuestion: 'Tell me about Published Beta',
  utterance: 'Tell me about Published Beta',
  queryUnderstanding: {
    ...baseInput.queryUnderstanding,
    explicitEntities: [explicitRecord], contextDependent: false,
    canonicalContext: explicitRecord,
  },
}, classification, { contextDependent: false }, scope);
assert.equal(explicit.canonicalEntity.recordId, explicitRecord.recordId);
assert.deepEqual(explicit.reservedRecords.map((entry) => entry.recordId), [explicitRecord.recordId]);

function evidence(recordId, recordType = 'CATALOG_ITEM') {
  return {
    id: `published:${recordType.toLowerCase()}:${recordId}`,
    recordId, recordType, tenantId: 'tenant-a', agentId: 'agent-a',
    knowledgeBaseId: 'kb-a', publicationRevision: 4,
    documentId: `document-${recordId}`, documentVersionId: `version-${recordId}`,
    hydrationValidated: true, publicationValidated: true, callerFacing: true,
    callerFacingHint: true, callerFacingValidated: true,
    authoritativeData: recordType === 'CATALOG_ITEM'
      ? { itemKey: recordId, name: recordId }
      : { question: recordId, answer: recordId },
  };
}

const authoritative = {
  tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
  reservations: [{
    tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 4,
    recordId: memoryRecord.recordId, recordType: 'CATALOG_ITEM', reason: 'canonical_memory',
  }],
  evidence: [
    evidence(memoryRecord.recordId),
    evidence('unrelated-faq', 'FAQ'),
    { ...evidence('unrelated-workflow', 'WORKFLOW_RULE'), callerFacing: false,
      authoritativeData: { actionType: 'configured_tool' } },
  ],
};
const packaged = buildGroundedLlmInput({
  input: baseInput,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
  authoritative, runtimeProfile: { tools: [] },
});
assert.deepEqual(packaged.hydratedRecords.map((entry) => entry.recordId), [
  memoryRecord.recordId,
], 'A contextual entity turn must exclude unrelated hydrated FAQ and Workflow records');

const optionalUseCaseRecord = 'unrelated-published-use-case';
const optionalUseCasePackage = buildGroundedLlmInput({
  input: baseInput,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
  authoritative: {
    ...authoritative,
    reservations: [
      authoritative.reservations[0],
      {
        tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 4,
        recordId: optionalUseCaseRecord, recordType: 'CATALOG_ITEM',
        reason: 'published_use_case',
      },
    ],
    evidence: [evidence(memoryRecord.recordId)],
  },
  runtimeProfile: { tools: [] },
});
assert.deepEqual(optionalUseCasePackage.hydratedRecords.map((entry) => entry.recordId), [
  memoryRecord.recordId,
], 'A missing published use-case record must not block a contextual price package');
assert.equal(optionalUseCasePackage.hydratedRecords[0].required, true);
assert.deepEqual(optionalUseCasePackage.hydratedRecords[0].reservationReasons, [
  'canonical_memory',
]);
const hydratedOptionalUseCasePackage = buildGroundedLlmInput({
  input: baseInput,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
  authoritative: {
    ...authoritative,
    reservations: [
      authoritative.reservations[0],
      {
        tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 4,
        recordId: optionalUseCaseRecord, recordType: 'CATALOG_ITEM',
        reason: 'published_use_case',
      },
    ],
    evidence: [evidence(memoryRecord.recordId), evidence(optionalUseCaseRecord)],
  },
  runtimeProfile: { tools: [] },
});
const optionalSupportingEvidence = hydratedOptionalUseCasePackage.hydratedRecords
  .find((entry) => entry.recordId === optionalUseCaseRecord);
assert.equal(optionalSupportingEvidence, undefined,
  'An unreserved published use case must not dilute a focused contextual turn');

assert.throws(() => buildGroundedLlmInput({
  input: baseInput,
  classification: { intentClass: 'DETAILS_OR_PRICE' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
  authoritative: { ...authoritative, evidence: [evidence('unrelated-faq', 'FAQ')] },
  runtimeProfile: { tools: [] },
}), (error) => error?.code === 'KNOWLEDGE_CONTEXT_RECORD_NOT_HYDRATED');

const comparisonRecords = ['compare-a', 'compare-b'];
const comparisonInput = {
  ...baseInput,
  queryUnderstanding: {
    explicitEntities: [], explicitCategories: [], contextDependent: false,
    comparisonEntities: comparisonRecords.map((recordId) => ({
      recordId, recordType: 'CATALOG_ITEM', name: recordId,
    })),
  },
};
const comparisonPackage = buildGroundedLlmInput({
  input: comparisonInput,
  classification: { intentClass: 'COMPARISON_COMPLEX' },
  resolution: { candidateNamespace: 'CATALOG' },
  authoritative: {
    tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
    reservations: comparisonRecords.map((recordId) => ({
      tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 4,
      recordId, recordType: 'CATALOG_ITEM', reason: 'explicit_comparison',
    })),
    evidence: comparisonRecords.map((recordId) => evidence(recordId)),
  },
  runtimeProfile: { tools: [] },
});
assert.deepEqual(comparisonPackage.hydratedRecords.map((entry) => entry.recordId), comparisonRecords);

const contextualComparisonInput = {
  ...baseInput,
  memory: {
    activeEntity: memoryRecord,
    comparisonEntities: comparisonInput.queryUnderstanding.comparisonEntities,
  },
  canonicalCallMemory: {
    activeEntity: memoryRecord,
    comparisonEntities: comparisonInput.queryUnderstanding.comparisonEntities,
  },
  queryUnderstanding: {
    ...comparisonInput.queryUnderstanding,
    contextDependent: true,
    comparisonContextSource: 'temporary_call_state',
  },
};
const contextualComparison = buildContextEnrichedRetrievalQuery(
  contextualComparisonInput,
  { ...classification, intentClass: 'COMPARISON_COMPLEX' },
  { candidateNamespace: 'CATALOG', contextDependent: true },
  scope,
);
assert.equal(contextualComparison.canonicalEntity, null);
assert.deepEqual(contextualComparison.reservedRecords.map((entry) => ({
  recordId: entry.recordId, reason: entry.reason,
})), comparisonRecords.map((recordId) => ({
  recordId, reason: 'contextual_comparison',
})), 'Temporary comparison records must exclude a stale singular active record');
assert.deepEqual(contextualComparison.exactComparisonLookups
  .map((entry) => entry.recordId), comparisonRecords);
const contextualComparisonReservations = collectCanonicalRetrievalReservations({
  input: contextualComparisonInput,
  classification: { ...classification, intentClass: 'COMPARISON_COMPLEX' },
  resolution: { candidateNamespace: 'CATALOG', contextDependent: true },
});
assert.deepEqual(contextualComparisonReservations.map((entry) => ({
  recordId: entry.recordId, reason: entry.reason,
})), comparisonRecords.map((recordId) => ({
  recordId, reason: 'contextual_comparison',
})));

const explicitIsolationInput = {
  ...baseInput,
  latestQuestion: 'Explain Published Beta',
  utterance: 'Explain Published Beta',
  queryUnderstanding: {
    explicitEntities: [explicitRecord], explicitCategories: [], comparisonEntities: [],
    currentEntityCandidates: [explicitRecord], contextDependent: false,
    canonicalContext: explicitRecord,
  },
};
const explicitIsolationPackage = buildGroundedLlmInput({
  input: explicitIsolationInput,
  classification: { intentClass: 'KNOWN_INFORMATION' },
  resolution: { candidateNamespace: 'CATALOG', candidate: explicitRecord },
  authoritative: {
    tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
    reservations: [{
      tenantId: 'tenant-a', knowledgeBaseId: 'kb-a', publicationRevision: 4,
      recordId: explicitRecord.recordId, recordType: 'CATALOG_ITEM',
      reason: 'explicit_entity',
    }],
    evidence: [
      evidence(explicitRecord.recordId),
      evidence(memoryRecord.recordId),
      evidence('unrelated-faq', 'FAQ'),
      evidence('unrelated-general', 'KNOWLEDGE_CHUNK'),
      evidence('unrelated-category', 'CATALOG_CATEGORY'),
    ],
  },
  runtimeProfile: { tools: [] },
});
assert.deepEqual(explicitIsolationPackage.hydratedRecords.map((entry) => entry.recordId), [
  explicitRecord.recordId,
], 'Explicit selection must remove stale memory and unrelated hydrated namespaces');

const boundedPackage = buildGroundedLlmInput({
  input: {
    ...baseInput,
    memory: {}, canonicalCallMemory: {},
    queryUnderstanding: {
      explicitEntities: [], explicitCategories: [], comparisonEntities: [],
      currentEntityCandidates: [], contextDependent: false,
    },
  },
  classification: { intentClass: 'UNKNOWN' },
  resolution: { candidate: null, candidateNamespace: null },
  authoritative: {
    tenantId: 'tenant-a', agentId: 'agent-a', callId: 'call-a',
    evidence: Array.from({ length: 7 }, (_value, index) => (
      evidence(`bounded-${index + 1}`, 'FAQ')
    )),
  },
  runtimeProfile: { tools: [] },
});
assert.equal(boundedPackage.hydratedRecords.length, 5,
  'Grounded packaging must cap valid relevant records at five without becoming empty');
assert.ok(boundedPackage.hydratedRecords.every((entry) => (
  entry.callerFacing === true
  && entry.callerFacingHint === true
  && entry.callerFacingValidated === true
  && entry.sourceId
)), 'Verified caller-facing metadata must survive canonical packaging');

console.log(JSON.stringify({
  success: true,
  task: 'Canonical request retrieval and mandatory-only evidence packaging',
}));
